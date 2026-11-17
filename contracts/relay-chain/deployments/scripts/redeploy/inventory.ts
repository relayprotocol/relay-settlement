import { existsSync } from "fs"
import {
  concatHex,
  keccak256,
  parseAbiItem,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"

import {
  payloadBuilderKeyFor,
  SINGLE_DEPOSITORY_VM_TYPES,
} from "../misc/verify-deployment/constants"
import {
  flattenDeployment,
  loadChainsConfig,
} from "../misc/verify-deployment/loaders"
import {
  accessControlAbi,
  allocatorAbi,
  builderAbi,
  councilFor,
  fromDeploymentKeys,
  CORE_CONTRACTS,
  depositoriesOf,
  inboxAbi,
  loadDeployment,
  loadState,
  log,
  multisigAbi,
  OPERATOR_ROLE,
  publicClient,
  requireChainId,
  sameAddress,
  saveState,
  statePath,
  usesStandaloneStore,
  type ChainTarget,
  type Env,
  type RedeployState,
  type Registration,
} from "./common"
import { withTimeout } from "../misc/verify-deployment/helpers"
import { encodedDepository } from "./configure"

// Builders whose constructor takes more than the Config address. Their inputs
// are read from the live builders so the redeploy reproduces them exactly.
const BUILDERS_WITH_INPUTS = [
  "bitcoinVmPayloadBuilder",
  "xrpVmPayloadBuilder",
  "hederaVmPayloadBuilder",
  "hyperliquidVmPayloadBuilder",
  "tonVmPayloadBuilder",
]

// Re-inventorying rebuilds `previous` from <env>.json. Once anything is
// deployed, that is only safe while <env>.json still holds the previous set:
// after update-records it would name the new contracts as the previous ones,
// and cutover would revoke the new set.
export function assertReinventorySafe(
  existing: RedeployState,
  flat: Record<string, Address>
) {
  const deployed = Object.entries(existing.deployed)
  if (deployed.length === 0) return
  const changed = [
    ...deployed
      .filter(([key, address]) => flat[key] && sameAddress(flat[key], address))
      .map(([key]) => `${key} is the deployed ${existing.deployed[key]}`),
    ...CORE_CONTRACTS.filter(
      (key) =>
        existing.previous[key] &&
        flat[key] &&
        !sameAddress(existing.previous[key], flat[key])
    ).map((key) => `${key} changed from ${existing.previous[key]}`),
  ]
  if (changed.length > 0) {
    throw new Error(
      `Refusing --force: the state has deployed contracts and <env>.json no longer holds the previous set (${changed.join("; ")}). ` +
        "Re-inventorying now would record the new contracts as the previous ones"
    )
  }
}

export type DroppedDepository = {
  chainId: string
  vmType: string
  depository: string
}

// A depository the redeploy skips must not hold a live registration on the
// previous allocator: the new allocator would silently lose it.
export async function assertNoDroppedRegistrations(
  client: Pick<PublicClient, "readContract">,
  allocator: Address,
  dropped: DroppedDepository[]
) {
  const live: string[] = []
  for (const { chainId, vmType, depository } of dropped) {
    let encoded: Hex
    try {
      encoded = encodedDepository(vmType, depository)
    } catch {
      throw new Error(
        `Cannot probe skipped depository ${chainId} (${vmType}) ${depository} on the previous allocator: its address cannot be encoded`
      )
    }
    const builder = (await client.readContract({
      abi: allocatorAbi,
      address: allocator,
      functionName: "payloadBuilders",
      args: [chainId, encoded],
    })) as Address
    if (!/^0x0{40}$/.test(builder)) {
      live.push(`${chainId} (${vmType}) ${depository} → ${builder}`)
    }
  }
  if (live.length > 0) {
    throw new Error(
      `The redeploy skips depositories that are registered on the previous allocator: ${live.join("; ")}. ` +
        "Fix the chain's builder or depository in the oracle chains config, or deregister it first"
    )
  }
}

const LOG_REQUEST_TIMEOUT_MS = 30_000
const LOG_RETRIES = 3
const LOG_RETRY_DELAY_MS = 1_000
// A wide range the RPC rejects, or one it cannot answer within the timeout
const LOG_RANGE_ERROR = /range|too many|limit|exceed|results|timed out/i
// A rate limit is retried after a wait, never answered with more requests
const LOG_RATE_LIMIT = /429|rate.?limit|too many requests/i

const payloadBuilderSetEvent = parseAbiItem(
  "event PayloadBuilderSet(string indexed chainId, bytes indexed depository, address indexed builder)"
)
type BuilderSetLog = {
  args: { chainId?: Hex; depository?: Hex; builder?: Address }
}
const pairKey = (chainIdHash: Hex, depositoryHash: Hex) =>
  `${chainIdHash.toLowerCase()}:${depositoryHash.toLowerCase()}`

// Pre-slug duplicate registrations a previous allocator still carries: the same
// depository and builder re-registered under the chain's numeric id before the
// slug naming convention. They duplicate a configured slug registration
// exactly, so the new allocator does not need them. inventory tolerates these
// declared pairs instead of failing on the unknown numeric (chainId,
// depository) pair, but only while the live builder still equals the configured
// duplicate's (see assertNoUnknownRegistrations), so a divergent numeric-keyed
// registration is never silently dropped. Scoped per env.
export const TOLERATED_STALE_REGISTRATIONS: Partial<
  Record<Env, DroppedDepository[]>
> = {
  // base-sepolia (84532) and sepolia (11155111): superseded by their
  // "base-sepolia"/"sepolia" slug registrations of the same depository and
  // builder on the test allocator 0xf62db37a….
  test: [
    {
      chainId: "84532",
      vmType: "ethereum-vm",
      depository: "0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3",
    },
    {
      chainId: "11155111",
      vmType: "ethereum-vm",
      depository: "0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3",
    },
  ],
}

// A registration of the previous allocator for a chain or depository the env
// no longer serves. The new allocator does not carry it over: it stays on the
// previous allocator, which loses its Hub role at cutover. Keyed by hashes,
// as PayloadBuilderSet indexes them, so a depository whose address is no
// longer on record can still be declared. Tolerated only while its live
// builder is still the declared one.
export type RetiredRegistration = {
  chainId: string
  depositoryHash: Hex
  builder: Address
  // What the depository is, for the log
  note: string
}

const retiredEvm = (
  chainIds: string[],
  depository: Address,
  builder: Address
): RetiredRegistration[] =>
  chainIds.map((chainId) => ({
    chainId,
    depositoryHash: keccak256(encodedDepository("ethereum-vm", depository)),
    builder,
    note: `ethereum-vm depository ${depository}`,
  }))

export const RETIRED_REGISTRATIONS: Partial<
  Record<Env, RetiredRegistration[]>
> = {
  // Chains removed from the stag chains config (#998 and earlier) and
  // depositories replaced since, all still registered on the stag allocator
  // 0xbdcd959c…1870. Their depositories must be empty before cutover.
  stag: [
    // On the pre-#769 EVM builder
    ...retiredEvm(
      [
        "lisk",
        "sei",
        "story",
        "swellchain",
        "cyber",
        "b3",
        "hemi",
        "superposition",
        "taiko",
        "syndicate",
        "zero",
        "degen",
        "ancient8",
        "rari",
      ],
      "0x9ddc6a541e8f8b50b0996786a3ec275ab4d3a76c",
      "0xF3c88Db9aECa22E30a31E7Df359F0b4FE48b0e90"
    ),
    ...retiredEvm(
      ["superseed", "arbitrum_nova", "anime", "blast"],
      "0x9ddc6a541e8f8b50b0996786a3ec275ab4d3a76c",
      "0x0d891D81f14B858F4512e35Db960DC42bA9DC5BF"
    ),
    ...retiredEvm(
      ["gunz"],
      "0xa4da4ec0558404cebba46bd112663723bc89829b",
      "0x0d891D81f14B858F4512e35Db960DC42bA9DC5BF"
    ),
    {
      chainId: "solana",
      depositoryHash:
        "0x8605b1db1267325d7e097c05e1898e3ab779abf8bdc2f72b7149b3b0edf54612",
      builder: "0x16e1A1C4C9334419A4FC290A31369c076D2F2A27",
      note: "replaced solana-vm depository",
    },
    {
      chainId: "eclipse",
      depositoryHash:
        "0x07fcb14ec191aab8daa6f5f09d8170f54b0a440711b0b62384068ca3ec394164",
      builder: "0x16e1A1C4C9334419A4FC290A31369c076D2F2A27",
      note: "replaced solana-vm depository",
    },
    {
      chainId: "tron",
      depositoryHash: keccak256(
        encodedDepository("tron-vm", "TXA7DuLt4FNgH9Sdvp36wqJggxzK8noKir")
      ),
      builder: "0x5A04454Fdad7D2b0Be6d7a85a7cDE09c1E1821Fc",
      note: "tron-vm depository TXA7DuLt4FNgH9Sdvp36wqJggxzK8noKir",
    },
  ],
  // Chains removed from the prod chains config, all still registered on the
  // prod allocator 0x613d3c58…57e2. Their depositories must be empty before
  // cutover.
  prod: [
    // On the earlier EVM builder
    ...retiredEvm(
      [
        "ancient8",
        "appchain",
        "arena_z",
        "b3",
        "corn",
        "cyber",
        "degen",
        "eden",
        "forma",
        "funki",
        "gravity",
        "hemi",
        "lisk",
        "mint",
        "perennial",
        "powerloom",
        "rari",
        "redstone",
        "sanko",
        "sei",
        "story",
        "superposition",
        "swellchain",
        "syndicate",
        "xai",
        "zorro",
      ],
      "0x4cd00e387622c35bddb9b4c962c136462338bc31",
      "0x982b49de82a3ea5B8c42895482D9dD9bfefaDf82"
    ),
    ...retiredEvm(
      ["polygon_zkevm", "taiko"],
      "0x59916da825d2d2ec1bf878d71c88826f6633ecca",
      "0x982b49de82a3ea5B8c42895482D9dD9bfefaDf82"
    ),
    ...retiredEvm(
      ["zero"],
      "0xa88cf7864951147a08707ed732237eaa9b1c3b9b",
      "0x982b49de82a3ea5B8c42895482D9dD9bfefaDf82"
    ),
    // On the current EVM builder
    ...retiredEvm(
      ["anime", "arbitrum_nova", "blast", "gunz", "superseed"],
      "0x4cd00e387622c35bddb9b4c962c136462338bc31",
      "0x6bc7e63264a77Bec501a16C309566f797D04d250"
    ),
    {
      chainId: "soon",
      depositoryHash: keccak256(
        encodedDepository(
          "solana-vm",
          "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2"
        )
      ),
      builder: "0x5c8a351D4fF680203e05aF56Cb9D748898C7b39a",
      note: "solana-vm depository 99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
    },
  ],
}

// Registrations the chains config does not know about: replays the previous
// allocator's PayloadBuilderSet events (from --from-block, its deploy block,
// in --log-page-size block chunks) and fails on any (chain, depository) whose
// last builder is non-zero and that is not in `known`. Both event arguments
// are indexed hashes, so an unknown one is reported by hash. Every live
// registration probed directly must appear in the scan, so a --from-block
// past the registrations fails instead of passing on an empty scan.
export async function assertNoUnknownRegistrations(
  client: Pick<PublicClient, "getBlockNumber" | "getLogs">,
  allocator: Address,
  // Every depository of the chains config, with its live builder when probed
  known: (DroppedDepository & { builder?: Address })[],
  fromBlock: bigint,
  pageSize: bigint,
  // Declared stale pre-slug duplicates to tolerate for this env
  tolerated: DroppedDepository[] = [],
  // Declared registrations of chains or depositories the env retired
  retired: RetiredRegistration[] = []
) {
  if (pageSize <= 0n) throw new Error("--log-page-size must be positive")
  const knownPairs = new Set(
    known.map(({ chainId, vmType, depository }) =>
      pairKey(
        keccak256(toBytes(chainId)),
        keccak256(encodedDepository(vmType, depository))
      )
    )
  )
  const latest = await client.getBlockNumber()
  const last = new Map<string, Address>()
  // One page: a per-request timeout, a bounded retry, and halving the range
  // when the RPC rejects it as too wide or too many results
  const page = async (
    from: bigint,
    to: bigint,
    attempt = 1
  ): Promise<BuilderSetLog[]> => {
    try {
      return await withTimeout(
        client.getLogs({
          address: allocator,
          event: payloadBuilderSetEvent,
          fromBlock: from,
          toBlock: to,
        }) as Promise<BuilderSetLog[]>,
        LOG_REQUEST_TIMEOUT_MS,
        `PayloadBuilderSet logs ${from}-${to}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        from < to &&
        LOG_RANGE_ERROR.test(message) &&
        !LOG_RATE_LIMIT.test(message)
      ) {
        const mid = (from + to) / 2n
        return [...(await page(from, mid)), ...(await page(mid + 1n, to))]
      }
      if (attempt < LOG_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, LOG_RETRY_DELAY_MS * attempt)
        )
        return page(from, to, attempt + 1)
      }
      throw error
    }
  }
  for (let start = fromBlock; start <= latest; start += pageSize) {
    const end = start + pageSize - 1n < latest ? start + pageSize - 1n : latest
    const logs = await page(start, end)
    for (const { args } of logs) {
      last.set(
        pairKey(args.chainId as Hex, args.depository as Hex),
        args.builder as Address
      )
    }
  }
  const depoHash = (vmType: string, depository: string) =>
    keccak256(encodedDepository(vmType, depository))
  // Tolerate a declared stale pair only while its live builder still equals the
  // configured (slug) registration's builder for the same depository, so a
  // numeric-keyed registration that has diverged is still reported as unknown.
  const toleratedPairs = new Set<string>()
  for (const stale of tolerated) {
    const pair = pairKey(
      keccak256(toBytes(stale.chainId)),
      depoHash(stale.vmType, stale.depository)
    )
    const liveBuilder = last.get(pair)
    if (!liveBuilder || /^0x0{40}$/.test(liveBuilder)) continue
    const configured = known.find(
      (k) =>
        k.builder &&
        k.vmType === stale.vmType &&
        depoHash(k.vmType, k.depository) ===
          depoHash(stale.vmType, stale.depository)
    )
    if (configured && sameAddress(configured.builder as Address, liveBuilder)) {
      toleratedPairs.add(pair)
    }
  }
  if (toleratedPairs.size > 0) {
    log(
      `  tolerating ${toleratedPairs.size} declared stale pre-slug registration(s)`
    )
  }
  // A retired pair is left on the previous allocator only while its live
  // builder is the declared one, so a re-registration is still reported.
  for (const entry of retired) {
    const pair = pairKey(
      keccak256(toBytes(entry.chainId)),
      entry.depositoryHash
    )
    const liveBuilder = last.get(pair)
    if (!liveBuilder || /^0x0{40}$/.test(liveBuilder)) {
      log(`  retired ${entry.chainId} (${entry.note}): already unregistered`)
      continue
    }
    if (!sameAddress(liveBuilder, entry.builder)) {
      throw new Error(
        `Retired registration ${entry.chainId} (${entry.note}) now points at ${liveBuilder}, not the declared ${entry.builder}`
      )
    }
    toleratedPairs.add(pair)
    log(
      `  retired ${entry.chainId} (${entry.note}) → ${liveBuilder}: left on the previous allocator`
    )
  }
  const unknown = [...last]
    .filter(
      ([pair, builder]) =>
        !/^0x0{40}$/.test(builder) &&
        !knownPairs.has(pair) &&
        !toleratedPairs.has(pair)
    )
    .map(([pair, builder]) => `${pair} → ${builder}`)
  const unseen = known
    .filter(
      ({ chainId, vmType, depository, builder }) =>
        builder &&
        !sameAddress(
          last.get(
            pairKey(
              keccak256(toBytes(chainId)),
              keccak256(encodedDepository(vmType, depository))
            )
          ) ?? "0x0000000000000000000000000000000000000000",
          builder
        )
    )
    .map(({ chainId, depository }) => `${chainId} ${depository}`)
  if (unseen.length > 0) {
    throw new Error(
      `The PayloadBuilderSet scan from block ${fromBlock} misses live registrations of the previous allocator (${unseen.join(", ")}): --from-block is after them, or the RPC drops old logs`
    )
  }
  if (unknown.length > 0) {
    throw new Error(
      `The previous allocator has registrations for chains or depositories absent from the chains config (keccak256(chainId):keccak256(depository)): ${unknown.join("; ")}`
    )
  }
  log(
    `  ${last.size} (chain, depository) pair(s) in PayloadBuilderSet events, all in the chains config`
  )
}

// The previous allocator's deployment block, where the event scan starts. The
// repo records no deploy blocks, so it is required rather than defaulting to 0.
export function fromBlockFlag(flags: Map<string, string | true>): bigint {
  const value = flags.get("from-block")
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(
      "Pass --from-block <the previous allocator's deployment block> (from its creation transaction on the hub explorer) for the PayloadBuilderSet scan"
    )
  }
  return BigInt(value)
}

export async function inventory(env: Env, flags: Map<string, string | true>) {
  const exists = existsSync(statePath(env))
  if (exists && !flags.has("force")) {
    throw new Error(
      `${statePath(env)} exists. Pass --force to re-inventory (this resets deployed addresses and steps)`
    )
  }
  const deployment = loadDeployment(env)
  const flat = fromDeploymentKeys(
    flattenDeployment(deployment) as Record<string, Address>
  )
  if (exists) assertReinventorySafe(loadState(env), flat)
  const client = publicClient(deployment.chainId)
  await requireChainId(client, deployment.chainId)

  const chains: ChainTarget[] = []
  // Depositories the redeploy will not register, probed on the previous
  // allocator below so no live registration is silently dropped
  const dropped: DroppedDepository[] = []
  for (const chain of loadChainsConfig(env)) {
    const builderKey = payloadBuilderKeyFor(chain)
    const depository =
      chain.depository ?? chain.gateway?.source?.gatewayDepository
    if (!builderKey || !depository) {
      log(`  skip ${chain.id} (${chain.vmType}): no builder or depository`)
      for (const raw of [depository, ...(chain.additionalDepositories ?? [])])
        if (raw)
          dropped.push({
            chainId: chain.id,
            vmType: chain.vmType,
            depository: raw,
          })
      continue
    }
    // The builder is registered per depository. Single-depository families
    // accept only the configured account, and the verifier flags their extras.
    const additional = SINGLE_DEPOSITORY_VM_TYPES.has(chain.vmType)
      ? []
      : (chain.additionalDepositories ?? [])
    if (additional.length !== (chain.additionalDepositories?.length ?? 0)) {
      log(
        `  ${chain.id} (${chain.vmType}): single-depository, additionalDepositories not registered`
      )
      for (const raw of chain.additionalDepositories ?? [])
        dropped.push({
          chainId: chain.id,
          vmType: chain.vmType,
          depository: raw,
        })
    }
    chains.push({
      id: chain.id,
      vmType: chain.vmType,
      depository,
      depositories: [...new Set([depository, ...additional])],
      builderKey,
      ...(chain.gateway?.source?.id
        ? { gatewaySource: chain.gateway.source.id }
        : {}),
    })
  }

  // Registrations on the current allocator, per depository, so verify can
  // check the new allocator carries every one over.
  const previousRegistrations: Registration[] = []
  for (const chain of chains) {
    for (const depository of depositoriesOf(chain)) {
      const builder = (await client.readContract({
        abi: allocatorAbi,
        address: flat.allocator,
        functionName: "payloadBuilders",
        args: [chain.id, encodedDepository(chain.vmType, depository)],
      })) as Address
      log(`  ${chain.id} (${chain.vmType}) ${depository}: ${builder}`)
      if (!/^0x0{40}$/.test(builder)) {
        previousRegistrations.push({ chainId: chain.id, depository, builder })
      }
    }
  }

  await assertNoDroppedRegistrations(client, flat.allocator, dropped)
  await assertNoUnknownRegistrations(
    client,
    flat.allocator,
    [
      ...chains.flatMap((chain) =>
        depositoriesOf(chain).map((depository) => ({
          chainId: chain.id,
          vmType: chain.vmType,
          depository,
          builder: previousRegistrations.find(
            (r) => r.chainId === chain.id && r.depository === depository
          )?.builder,
        }))
      ),
      ...dropped,
    ],
    fromBlockFlag(flags),
    BigInt(String(flags.get("log-page-size") ?? "10000")),
    TOLERATED_STALE_REGISTRATIONS[env] ?? [],
    RETIRED_REGISTRATIONS[env] ?? []
  )

  const previous: Record<string, Address> = { ...flat }
  const tonChains = chains.filter((chain) => chain.vmType === "ton-vm")
  if (tonChains.length > 1) {
    throw new Error(
      `TonVmPayloadBuilder is bound to one chain id; ${tonChains.length} ton-vm chains need one builder each`
    )
  }

  const read = <T>(address: Address, functionName: string) =>
    client.readContract({
      abi: builderAbi,
      address,
      functionName,
    } as never) as Promise<T>

  // The new inbox writes the live oracle's store, so the two are mutually
  // exclusive in either order. Refuse to go on if <env>.json and the chain
  // disagree on which store that is. In standalone mode the live oracle has no
  // shared store, so --phase deploy deploys a fresh one for the new inbox.
  const standaloneStore = usesStandaloneStore(env)
  let idempotencyStore: Address | undefined
  if (standaloneStore) {
    // Standalone mode shares no replay protection with the live oracle, which
    // is safe only while that oracle cannot execute on the Hub
    const oracleIsOperator = (await client.readContract({
      abi: accessControlAbi,
      address: flat.hub,
      functionName: "hasRole",
      args: [OPERATOR_ROLE, flat.inbox],
    })) as boolean
    if (oracleIsOperator) {
      throw new Error(
        `Standalone store mode for ${env}, but the live oracle ${flat.inbox} still holds Hub OPERATOR_ROLE: an execution signed for it could replay on the new inbox. Revoke it first, or share its store`
      )
    }
    log(
      `  idempotency store: standalone (a fresh store is deployed for the new inbox; the live oracle shares none and holds no Hub OPERATOR_ROLE)`
    )
  } else {
    idempotencyStore = flat.inboxIdempotencyStore
    if (!idempotencyStore) {
      throw new Error(`${env}.json has no oracleIdempotencyStore`)
    }
    const liveStore = (await client.readContract({
      abi: inboxAbi,
      address: flat.inbox,
      functionName: "IDEMPOTENCY_STORE",
    })) as Address
    if (liveStore.toLowerCase() !== idempotencyStore.toLowerCase()) {
      throw new Error(
        `Live oracle ${flat.inbox} uses store ${liveStore}, but ${env}.json records ${idempotencyStore}`
      )
    }
  }

  const needed = new Set(chains.map((chain) => chain.builderKey))
  const inputs: RedeployState["inputs"] = {
    ...(idempotencyStore ? { idempotencyStore } : {}),
    ...(standaloneStore ? { standaloneIdempotencyStore: true } : {}),
    multisigSigners: (await client.readContract({
      abi: multisigAbi,
      address: flat.inboxMultisig,
      functionName: "getSigners",
    })) as Address[],
    multisigThreshold: String(
      await client.readContract({
        abi: multisigAbi,
        address: flat.inboxMultisig,
        functionName: "threshold",
      })
    ),
    rateLimiter: flat.rateLimiter,
    feeCalculator: flat.feeCalculator,
    fundingPools: [
      ...(flat.fundingPool ? [flat.fundingPool] : []),
      ...String(flags.get("funding-pools") ?? "")
        .split(",")
        .filter(Boolean)
        .map((pool) => pool as Address),
    ],
  }

  for (const key of BUILDERS_WITH_INPUTS) {
    if (!needed.has(key)) continue
    const address = flat[key]
    if (!address)
      throw new Error(`${env}.json has no ${key} to copy inputs from`)
    switch (key) {
      case "bitcoinVmPayloadBuilder":
        inputs.bitcoinChangeScript = await read<Hex>(
          address,
          "allocatorChangeScript"
        )
        break
      case "xrpVmPayloadBuilder":
        inputs.xrpSigningPubkey = concatHex([
          await read<Hex>(address, "SIGNING_PUBKEY_PREFIX"),
          await read<Hex>(address, "SIGNING_PUBKEY_BODY"),
        ])
        break
      case "hederaVmPayloadBuilder":
        inputs.hederaTokenNum = String(await read<bigint>(address, "TOKEN_NUM"))
        break
      case "hyperliquidVmPayloadBuilder":
        inputs.hyperliquidSignatureChainId = String(
          await read<bigint>(address, "SIGNATURE_CHAIN_ID")
        )
        inputs.hyperliquidChain = await read<string>(
          address,
          "hyperliquidChain"
        )
        break
      case "tonVmPayloadBuilder":
        inputs.tonChainId = tonChains[0].id
        inputs.tonSubwalletId = String(
          await read<number>(address, "SUBWALLET_ID")
        )
        inputs.tonTimeout = String(await read<number>(address, "TIMEOUT"))
        break
    }
  }

  const state: RedeployState = {
    env,
    chainId: deployment.chainId,
    inventoriedAt: new Date().toISOString(),
    hub: flat.hub,
    config: flat.config,
    council: councilFor(env),
    previous,
    inputs,
    chains,
    previousRegistrations,
    deployed: {},
    steps: {},
  }
  saveState(state)
  log(`\nInventory written to ${statePath(env)}`)
  log(`  ${chains.length} chains, builders: ${[...needed].sort().join(", ")}`)
  log(
    `  oracle multisig: ${inputs.multisigSigners.length} signers, threshold ${inputs.multisigThreshold}`
  )
  log(`  funding pools: ${inputs.fundingPools.join(", ") || "none"}`)
  log(
    standaloneStore
      ? `  idempotency store: standalone (deployed in --phase deploy)`
      : `  idempotency store (shared with the live oracle): ${idempotencyStore}`
  )
}
