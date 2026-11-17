// ABOUTME: generates the manifest that allowlists (or revokes) a Solana router program for
// ABOUTME: routed withdrawals on the SolanaVmPayloadBuilder, per chain and depository.
//
// One action, gated on the allocator owner (Config resolves onlyAllocatorOwner from the
// allocator), which is the security council on stag/prod:
//   Config.setConfigValues(keys, values)
//     SOLANA_VM_ROUTER_ALLOWED:<chainId, depository, router> = VALUE
//
// VALUE 1 allows the router; anything else revokes it (Config cannot delete a key). Keys
// are read from the builder's `getRouterAllowedKey` so the manifest cannot drift from the
// contract. Allowing requires the allocator's registered builder for the chain and
// depository to be PAYLOAD_BUILDER and routed-capable: a builder without routed mode
// ignores the data and would sign a plain transfer to the bundle, which anyone can land
// without the fill. Revoking skips that check. Keys already at VALUE are skipped.
// With REGISTER_BUILDER=1 the manifest instead registers PAYLOAD_BUILDER first
// (allocator.setPayloadBuilder), so nonce order lands it before the allowlist write.
//
// Env:
//   ENV              dev | stag | prod. Defaults to "prod".
//   ROUTER           router program id (base58), required.
//   CHAINS           optional comma-separated solana-vm chain slugs. Defaults to "solana".
//   DEPOSITORY       optional depository program id (base58). Defaults to the env's
//                    depository in settlement-networks; only valid with a single chain.
//   VALUE            optional decimal allowlist value. Defaults to 1 (allow); 0 revokes.
//   PAYLOAD_BUILDER  optional 0x builder address. Defaults to the env's
//                    payloadBuilders.solanaVmPayloadBuilder.
//   RELAY_NONCE_OFFSET  optional number added to the on-chain nonce, for relay-chain
//                    transactions queued in earlier manifests but not yet mined.
//   SIGNER           optional 0x signer address to use as `from`. When set, the NEAR/MPC
//                    derivation is skipped.
//   REGISTER_BUILDER "1" registers PAYLOAD_BUILDER where another builder is registered,
//                    in the same manifest. Only with VALUE=1.
//   DRY_RUN          "1" prints the calls without fetching nonces or writing a manifest.
//
// Usage:
//   ENV=stag ROUTER=<base58> DEPOSITORY=<base58> yarn workspace \
//     @relay-settlement/multisig-tools tsx scripts/generate-configure-solana-router-allowlist.ts
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Hex,
} from "viem"
import {
  aurora,
  networks,
  relay as relayChain,
  relayTestnet,
} from "@relay-protocol/settlement-networks"
import { encodeAddress } from "@relay-protocol/settlement-sdk"
import { readConfigWord } from "../../../contracts/relay-chain/deployments/scripts/routerRollout"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

type Env = "dev" | "stag" | "prod"

export type SolanaRouterTuple = {
  /** Relay chain id, which for Solana chains is the network slug. */
  chain: string
  /** Depository program id, base58. */
  depository: string
}

export type ReadClient = {
  readContract: (_args: {
    abi: unknown
    address: Hex
    args?: readonly unknown[]
    functionName: string
  }) => Promise<unknown>
}

type Call = { calldata: Hex; label: string; to: Hex }

const allocatorAbi = parseAbi([
  "function payloadBuilders(string chainId, bytes depository) view returns (address)",
  "function setPayloadBuilder(string chainId, bytes depository, address payloadBuilder)",
])

const configAbi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
])

export const solanaPayloadBuilderAbi = parseAbi([
  "function getRouterAllowedKey(string chainId, bytes32 depository, bytes32 router) view returns (bytes32)",
])

const uint256Word = (value: bigint): Hex =>
  `0x${value.toString(16).padStart(64, "0")}`

const encodeSolana = (value: string, name: string): Hex => {
  let encoded: Hex
  try {
    encoded = bytesToHex(encodeAddress(value, "solana-vm"))
  } catch (error) {
    throw new Error(`${name} is not a base58 Solana address: ${value}`, {
      cause: error,
    })
  }
  if (encoded.length !== 66) {
    throw new Error(`${name} does not encode to 32 bytes: ${value}`)
  }
  return encoded
}

export const resolveTuples = (args: {
  chains?: string
  depository?: string
  env: Env
}): SolanaRouterTuple[] => {
  const slugs = (args.chains ?? "solana").split(",").filter(Boolean)
  if (args.depository && slugs.length !== 1) {
    throw new Error(
      "DEPOSITORY overrides a single chain; set CHAINS to one slug"
    )
  }
  return slugs.map((slug) => {
    const net = networks[slug]
    if (!net) throw new Error(`${slug}: not in settlement-networks`)
    if (net.family !== "solana-vm") {
      throw new Error(`${slug}: family is ${net.family}, not solana-vm`)
    }
    const depository = args.depository ?? net.contracts?.[args.env]?.depository
    if (!depository) {
      throw new Error(
        `${slug}: no ${args.env} depository in settlement-networks -- pass DEPOSITORY`
      )
    }
    return { chain: slug, depository }
  })
}

/**
 * Returns the Config write for every tuple whose allowlist value is not already `value`.
 * Throws when allowing a router behind a builder that is not `payloadBuilder` or has no
 * routed mode, unless `registerBuilder` puts the registration first.
 */
export const buildSolanaRouterAllowlistCalls = async (args: {
  allocator: Hex
  client: ReadClient
  config: Hex
  payloadBuilder: Hex
  registerBuilder?: boolean
  router: string
  tuples: SolanaRouterTuple[]
  value: bigint
}): Promise<Call[]> => {
  const router = encodeSolana(args.router, "ROUTER")
  const value = uint256Word(args.value)
  const allow = args.value === 1n
  if (args.registerBuilder && !allow) {
    throw new Error("REGISTER_BUILDER only applies when allowing (VALUE=1)")
  }
  const registrations: Call[] = []
  const keys: Hex[] = []

  for (const tuple of args.tuples) {
    const depository = encodeSolana(
      tuple.depository,
      `${tuple.chain} depository`
    )
    const label = `${tuple.chain} depository=${tuple.depository} router=${args.router} allowed=${args.value}`

    if (allow) {
      const registered = (await args.client.readContract({
        abi: allocatorAbi,
        address: args.allocator,
        args: [tuple.chain, depository],
        functionName: "payloadBuilders",
      })) as Hex
      if (registered.toLowerCase() !== args.payloadBuilder.toLowerCase()) {
        if (!args.registerBuilder) {
          throw new Error(
            `${tuple.chain}: registered builder is ${registered}, not ${args.payloadBuilder} -- register the routed builder before allowlisting`
          )
        }
        console.log(
          `  [reg ] ${tuple.chain} depository=${tuple.depository} builder ${registered} -> ${args.payloadBuilder}`
        )
        registrations.push({
          calldata: encodeFunctionData({
            abi: allocatorAbi,
            args: [tuple.chain, depository, args.payloadBuilder],
            functionName: "setPayloadBuilder",
          }),
          label: `allocator.setPayloadBuilder(${tuple.chain}, ${tuple.depository}, ${args.payloadBuilder})`,
          to: args.allocator,
        })
      }
    }

    let key: Hex
    try {
      key = (await args.client.readContract({
        abi: solanaPayloadBuilderAbi,
        address: args.payloadBuilder,
        args: [tuple.chain, depository, router],
        functionName: "getRouterAllowedKey",
      })) as Hex
    } catch (error) {
      throw new Error(
        `${args.payloadBuilder} has no getRouterAllowedKey -- not a routed-capable SolanaVmPayloadBuilder`,
        { cause: error }
      )
    }

    const current = await readConfigWord(args.client as never, args.config, key)
    if (current?.toLowerCase() === value.toLowerCase()) {
      console.log(`  [skip] ${label} already set`)
      continue
    }
    console.log(`  [set ] ${label} key=${key} was=${current ?? "unset"}`)
    keys.push(key)
  }

  if (keys.length === 0) return registrations
  return [
    ...registrations,
    {
      calldata: encodeFunctionData({
        abi: configAbi,
        args: [keys, keys.map(() => value)],
        functionName: "setConfigValues",
      }),
      label: `config.setConfigValues(${keys.length} SOLANA_VM_ROUTER_ALLOWED keys = ${args.value})`,
      to: args.config,
    },
  ]
}

const main = async () => {
  const env = (process.env.ENV ?? "prod") as Env
  if (env !== "dev" && env !== "stag" && env !== "prod") {
    throw new Error(`ENV must be dev, stag or prod (got "${env}")`)
  }
  const router = process.env.ROUTER
  if (!router) throw new Error("set ROUTER (router program id, base58)")
  const rawValue = process.env.VALUE ?? "1"
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`VALUE must be a non-negative decimal integer: ${rawValue}`)
  }
  const value = BigInt(rawValue)

  const records = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../contracts/relay-chain/deployments/contracts/${env}.json`
      ),
      "utf8"
    )
  ) as {
    core: Record<string, string>
    payloadBuilders: Record<string, string>
  }
  const payloadBuilder = (process.env.PAYLOAD_BUILDER ??
    records.payloadBuilders.solanaVmPayloadBuilder) as Hex
  if (!/^0x[0-9a-fA-F]{40}$/.test(payloadBuilder ?? "")) {
    throw new Error(
      `PAYLOAD_BUILDER or payloadBuilders.solanaVmPayloadBuilder in contracts/${env}.json is not a valid address: ${String(payloadBuilder)}`
    )
  }

  const tuples = resolveTuples({
    chains: process.env.CHAINS,
    depository: process.env.DEPOSITORY,
    env,
  })

  const chain = env === "dev" ? relayTestnet : relayChain
  const rpcUrl = chain.rpc[0]
  const client = createPublicClient({ transport: http(rpcUrl) })
  // reads against the wrong chain silently return empty values
  const liveChainId = await client.getChainId()
  if (BigInt(liveChainId) !== chain.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${chain.chainId} for env "${env}"`
    )
  }

  console.log(`env: ${env}`)
  console.log(`payloadBuilder: ${payloadBuilder}`)
  const calls = await buildSolanaRouterAllowlistCalls({
    allocator: records.core.allocator as Hex,
    client: client as unknown as ReadClient,
    config: records.core.config as Hex,
    payloadBuilder,
    registerBuilder: process.env.REGISTER_BUILDER === "1",
    router,
    tuples,
    value,
  })
  if (calls.length === 0) {
    console.log("Nothing to do -- allowlist already matches")
    return
  }
  if (process.env.DRY_RUN === "1") {
    for (const call of calls) {
      console.log(
        `  ${call.label}\n    to:   ${call.to}\n    data: ${call.calldata}`
      )
    }
    console.log("DRY_RUN=1: no manifest written")
    return
  }

  let signerAddress = process.env.SIGNER as Hex | undefined
  if (signerAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(signerAddress)) {
      throw new Error(`SIGNER is not a valid address: ${signerAddress}`)
    }
  } else {
    const multisigSigner = aurora.contracts?.[env]?.multisigSigner
    if (!multisigSigner) {
      throw new Error(`No aurora multisigSigner configured for env "${env}"`)
    }
    const auroraClient = createPublicClient({ transport: http(aurora.rpc[0]) })
    signerAddress = (await deriveAllocatorSignerAddress(
      auroraClient,
      multisigSigner,
      "ethereum-vm"
    )) as Hex | undefined
    if (!signerAddress) throw new Error("Failed to derive signer")
  }
  console.log(`Using signer from MPC : ${signerAddress}`)

  const nonceOffset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  const [baseNonce, gasEstimates] = await Promise.all([
    client
      .getTransactionCount({ address: signerAddress })
      .then((count) => count + nonceOffset),
    Promise.all(
      calls.map((call) =>
        client.estimateGas({
          account: signerAddress,
          data: call.calldata,
          to: call.to,
        })
      )
    ),
  ])

  const txs = calls.map((call, i) => {
    console.log(`  [nonce ${baseNonce + i}] ${call.label}`)
    return {
      amount: "0",
      calldata: call.calldata,
      family: "ethereum-vm",
      from: signerAddress,
      gas: ((gasEstimates[i] * 110n) / 100n).toString(),
      maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
      maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
      nonce: baseNonce + i,
      rpc: rpcUrl,
      to: call.to,
    }
  })

  const path = getManifestPath(
    "configure-solana-router-allowlist",
    `${env}-${value === 1n ? "allow" : "revoke"}`,
    env
  )
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
