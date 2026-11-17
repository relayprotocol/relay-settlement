import { mkdirSync, readdirSync, writeFileSync } from "fs"
import { join } from "path"
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem"

import { DEFAULT_RELAY_RPCS } from "../misc/verify-deployment/constants"
import {
  accessControlAbi,
  allocatorAbi,
  carriedOverDepositories,
  configAbi,
  CONSUMER_ROLE,
  depositoriesOf,
  loadState,
  log,
  OPERATOR_ROLE,
  ORACLE_ROLE,
  ownableAbi,
  publicClient,
  REPO_ROOT,
  requireChainId,
  resolveIdempotencyStore,
  RESOLVER_ROLE,
  sameAddress,
  WRITE_ROLE,
  type ChainTarget,
  type Env,
  type RedeployState,
} from "./common"
import {
  configAdmin,
  gatewayConfigWrites,
  lighterConfigWrites,
  tonConfigWrites,
  type ConfigWrite,
} from "./config-values"
import { CUTOVER_VM_TYPES, encodedDepository } from "./configure"

// Fee cap per hub chain. The Relay hub chains (Sovereign devnet/mainnet) run a
// 7 wei EIP-1559 cap; a public L2 hub like Arbitrum Sepolia (the test env) has a
// base fee far above that, so its manifests need a real cap or execute-time
// assertEvmFeeCap rejects them. Matches the 1 gwei used by prior test manifests.
const MAX_FEE_PER_GAS_BY_CHAIN: Record<number, string> = {
  421614: "1000000000", // Arbitrum Sepolia (test hub)
}
const DEFAULT_MAX_FEE_PER_GAS = "7"
const maxFeePerGasFor = (chainId: number) =>
  MAX_FEE_PER_GAS_BY_CHAIN[chainId] ?? DEFAULT_MAX_FEE_PER_GAS
const MAX_PRIORITY_FEE_PER_GAS = "0"

type Call = {
  label: string
  to: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  // Already in place on-chain, so the call is left out
  skip?: () => Promise<boolean>
}

const manifestsDir = (env: Env) =>
  join(REPO_ROOT, "packages/multisig-tools/transactions", env)

function nextManifestPath(env: Env, name: string) {
  const dir = manifestsDir(env)
  mkdirSync(dir, { recursive: true })
  const latest = readdirSync(dir)
    .filter((file) => /^\d{3}-/.test(file))
    .map((file) => parseInt(file.slice(0, 3), 10))
    .reduce((max, n) => Math.max(max, n), 0)
  return join(dir, `${String(latest + 1).padStart(3, "0")}-${name}-${env}.json`)
}

async function writeManifest(
  state: RedeployState,
  name: string,
  calls: Call[],
  dryRun: boolean
) {
  const client = publicClient(state.chainId)
  await requireChainId(client, state.chainId)
  const council = state.council
  // Never write a token-bearing RPC into a committed manifest
  const rpc = DEFAULT_RELAY_RPCS[state.chainId]
  let nonce =
    (await client.getTransactionCount({
      address: council,
      blockTag: "pending",
    })) + Number(process.env.NONCE_OFFSET ?? 0)

  const txs = []
  for (const call of calls) {
    if (call.skip && (await call.skip())) {
      log(`  ✓ ${call.label} (already in place)`)
      continue
    }
    const calldata = encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never) as Hex
    const gas = await client
      .estimateGas({ account: council, to: call.to, data: calldata })
      .catch((error: Error) => {
        throw new Error(
          `${call.label} reverts when simulated from the council: ${error.message.split("\n")[0]}`
        )
      })
    txs.push({
      amount: "0",
      calldata,
      family: "ethereum-vm",
      from: council,
      gas: String((gas * 11n) / 10n),
      maxFeePerGas: maxFeePerGasFor(state.chainId),
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
      nonce: nonce++,
      rpc,
      to: call.to,
    })
    log(`  + ${call.label}`)
  }
  if (txs.length === 0) {
    log("Nothing to do: every call is already in place")
    return
  }
  if (dryRun) {
    log(`Would write ${txs.length} transaction(s)`)
    return
  }
  const path = nextManifestPath(state.env, name)
  writeFileSync(path, JSON.stringify(txs, null, 2) + "\n")
  log(`\nWrote ${path}`)
  log(`Simulate and submit it from packages/multisig-tools:`)
  log(
    `  yarn multisig:simulate --transactions ${path.split("multisig-tools/")[1]}`
  )
  log(
    `  yarn multisig:submit --env ${state.env} --network aurora --transactions ${path.split("multisig-tools/")[1]}`
  )
}

function roleCall(
  state: RedeployState,
  label: string,
  contract: Address,
  roleId: Hex,
  account: Address,
  action: "grantRole" | "revokeRole"
): Call {
  const client = publicClient(state.chainId)
  return {
    label,
    to: contract,
    abi: accessControlAbi,
    functionName: action,
    args: [roleId, account],
    skip: async () => {
      const has = await client.readContract({
        abi: accessControlAbi,
        address: contract,
        functionName: "hasRole",
        args: [roleId, account],
      })
      return action === "grantRole" ? has : !has
    },
  }
}

// Additive grants that wire the new contracts in while the previous ones keep
// working: the Hub, rate limiter, store and funding pools accept the new
// contracts, and abandoned inboxes lose their roles. The council is the admin
// of each, so none depends on another call.
function wireCalls(state: RedeployState): Call[] {
  const d = state.deployed
  const store = resolveIdempotencyStore(state)
  if (!store) {
    throw new Error(
      "No idempotency store resolved; run --phase inventory and --phase deploy first"
    )
  }
  const calls: Call[] = [
    roleCall(
      state,
      "Hub OPERATOR_ROLE → allocator",
      state.hub,
      OPERATOR_ROLE,
      d.allocator,
      "grantRole"
    ),
    roleCall(
      state,
      "Hub OPERATOR_ROLE → executor",
      state.hub,
      OPERATOR_ROLE,
      d.executor,
      "grantRole"
    ),
    roleCall(
      state,
      "Hub OPERATOR_ROLE → inbox",
      state.hub,
      OPERATOR_ROLE,
      d.inbox,
      "grantRole"
    ),
    // The council is the store's admin (the shared live store, or the fresh
    // standalone store handed over in standalone mode). Its WRITE_ROLE lets the
    // new inbox mark executions; sharing the live store is what keeps an
    // execution signed for both the inbox and the live oracle from running twice.
    roleCall(
      state,
      "idempotency store WRITE_ROLE → inbox",
      store,
      WRITE_ROLE,
      d.inbox,
      "grantRole"
    ),
  ]
  if (state.inputs.rateLimiter) {
    calls.push(
      roleCall(
        state,
        "rate limiter CONSUMER_ROLE → inbox",
        state.inputs.rateLimiter,
        CONSUMER_ROLE,
        d.inbox,
        "grantRole"
      )
    )
  }
  for (const pool of state.inputs.fundingPools) {
    calls.push(
      roleCall(
        state,
        `FundingPool ${pool} RESOLVER_ROLE → pool draw resolver`,
        pool,
        RESOLVER_ROLE,
        d.poolDrawResolver,
        "grantRole"
      )
    )
  }
  for (const inbox of state.abandonedInboxes ?? []) {
    calls.push(
      roleCall(
        state,
        `Hub OPERATOR_ROLE ✗ abandoned inbox ${inbox}`,
        state.hub,
        OPERATOR_ROLE,
        inbox,
        "revokeRole"
      )
    )
    if (state.inputs.rateLimiter) {
      calls.push(
        roleCall(
          state,
          `rate limiter CONSUMER_ROLE ✗ abandoned inbox ${inbox}`,
          state.inputs.rateLimiter,
          CONSUMER_ROLE,
          inbox,
          "revokeRole"
        )
      )
    }
    // The abandoned run granted it WRITE_ROLE on the same store; an inbox
    // left with it could mark executions on the live replay-protection store
    calls.push(
      roleCall(
        state,
        `idempotency store WRITE_ROLE ✗ abandoned inbox ${inbox}`,
        store,
        WRITE_ROLE,
        inbox,
        "revokeRole"
      )
    )
  }
  return calls
}

// Config.setConfigValues as council calls. The Config admin is the council
// both before and after Config.setAllocator, so these never depend on it.
function configWriteCalls(state: RedeployState, writes: ConfigWrite[]): Call[] {
  return writes.map((write) => ({
    label: write.label,
    to: state.config,
    abi: configAbi,
    functionName: "setConfigValues",
    args: [write.keys, write.values],
  }))
}

// The oracle multisig is Ownable2Step: the council accepts the deployer's
// transferOwnership from handover. Needs only that pendingOwner.
function acceptOwnershipCall(state: RedeployState): Call {
  const client = publicClient(state.chainId)
  return {
    label: "RelayInboxMultisig.acceptOwnership()",
    to: state.deployed.inboxMultisig,
    abi: ownableAbi,
    functionName: "acceptOwnership",
    args: [],
    skip: async () =>
      sameAddress(
        (await client.readContract({
          abi: ownableAbi,
          address: state.deployed.inboxMultisig,
          functionName: "owner",
        })) as Address,
        state.council
      ),
  }
}

// Config follows the new allocator: the Config admin goes from the council
// (previous allocator owner) to the council (new allocator owner). It needs
// only the caller to own the allocator Config points at now (the previous
// one, the council's) and the new one to have a non-zero owner, so it
// simulates on its own, ahead of the other calls in its manifest.
function setAllocatorCall(state: RedeployState): Call {
  const newAllocator = state.deployed.allocator
  return {
    label: "Config.setAllocator(new allocator)",
    to: state.config,
    abi: configAbi,
    functionName: "setAllocator",
    args: [newAllocator],
    skip: async () =>
      sameAddress((await configAdmin(state)).allocator, newAllocator),
  }
}

// What the council's round 1 needs from handover: it owns the new allocator
// (one-step Ownable), is the inbox multisig's pending owner (or already its
// owner), and is the Config admin.
async function requireHandedOver(state: RedeployState) {
  const client = publicClient(state.chainId)
  const d = state.deployed
  const read = (address: Address, functionName: "owner" | "pendingOwner") =>
    client.readContract({
      abi: ownableAbi,
      address,
      functionName,
    }) as Promise<Address>
  const allocatorOwner = await read(d.allocator, "owner")
  if (!sameAddress(allocatorOwner, state.council)) {
    throw new Error(
      `New allocator owner is ${allocatorOwner}, not the council: run --phase handover first`
    )
  }
  if (
    !sameAddress(await read(d.inboxMultisig, "owner"), state.council) &&
    !sameAddress(await read(d.inboxMultisig, "pendingOwner"), state.council)
  ) {
    throw new Error(
      "The council is neither the owner nor the pending owner of the inbox multisig: run --phase handover first"
    )
  }
  const { owner: configOwner } = await configAdmin(state)
  if (!sameAddress(configOwner, state.council)) {
    throw new Error(
      `The Config admin is ${configOwner}, not the council: run --phase handover first`
    )
  }
}

// Round 3 preconditions. The chain shows activation and the round 2
// registrations; the solver config and in-flight work it cannot see, so the
// operator confirms those with CONFIRM_RETIREMENT=1.
async function requireRetirementReady(state: RedeployState) {
  if (process.env.CONFIRM_RETIREMENT !== "1") {
    throw new Error(
      "Set CONFIRM_RETIREMENT=1 once DEC-2469 step 6 holds: DEC-2471 has shipped, the solver and every service use the new contracts, and the previous allocator, executor and oracle have nothing in flight (XRP, TON and Gateway withdrawals, Gateway external fills, the previous-oracle rollback)"
    )
  }
  await requireActivated(state)
  const client = publicClient(state.chainId)
  const missing: string[] = []
  for (const chain of state.chains.filter((c) =>
    CUTOVER_VM_TYPES.has(c.vmType)
  )) {
    const builder = state.deployed[chain.builderKey]
    for (const depository of carriedOverDepositories(state, chain)) {
      const registered = (await client.readContract({
        abi: allocatorAbi,
        address: state.deployed.allocator,
        functionName: "payloadBuilders",
        args: [chain.id, encodedDepository(chain.vmType, depository)],
      })) as Address
      if (!builder || !sameAddress(registered, builder))
        missing.push(`${chain.id} ${depository}`)
    }
  }
  if (missing.length === 0) return
  if (process.env.ALLOW_PARTIAL_RETIREMENT !== "1") {
    throw new Error(
      `Not registered on the new allocator yet: ${missing.join(", ")}. Run manifest-register for them first, or set ALLOW_PARTIAL_RETIREMENT=1 to retire anyway`
    )
  }
  log(
    `⚠️  ALLOW_PARTIAL_RETIREMENT=1: retiring while ${missing.join(", ")} are not registered on the new allocator\n`
  )
}

// Round 2 needs round 1 executed: the new allocator holds Hub OPERATOR_ROLE
// and Config points at it, so the shared Gateway keys never change ahead of it
async function requireActivated(state: RedeployState) {
  const client = publicClient(state.chainId)
  const operator = (await client.readContract({
    abi: accessControlAbi,
    address: state.hub,
    functionName: "hasRole",
    args: [OPERATOR_ROLE, state.deployed.allocator],
  })) as boolean
  const { allocator } = await configAdmin(state)
  if (!operator || !sameAddress(allocator, state.deployed.allocator)) {
    throw new Error(
      "manifest-activate has not executed (the new allocator lacks Hub OPERATOR_ROLE or Config does not point at it): have the council execute it first"
    )
  }
}

// Round 1, the one council manifest of the deploy, after handover: the
// wire-in grants, the Lighter Config migration (#927 key derivation), the
// inbox multisig acceptance, and Config.setAllocator last. Until it executes,
// the new contracts hold no Hub role. Every call simulates from the council
// against the current state without needing an earlier call of this manifest
// (the council already administers each target), so no gas is fixed.
export async function manifestActivate(env: Env, dryRun: boolean) {
  const state = loadState(env)
  await requireHandedOver(state)
  await writeManifest(
    state,
    "activate-redeployed-contracts",
    [
      ...wireCalls(state),
      ...configWriteCalls(state, await lighterConfigWrites(state)),
      acceptOwnershipCall(state),
      setAllocatorCall(state),
    ],
    dryRun
  )
}

// Retirement of the previous contracts (DEC-2469 step 6): revocations only,
// no registrations and no Config writes. During the additive rollout the
// previous allocator, executor and oracle still serve XRP, TON and Gateway
// withdrawals, Gateway external fills (previous executor and payGas) and the
// previous-oracle rollback, so run this only once DEC-2471 has shipped and the
// previous contracts have nothing in flight. The previous oracle keeps
// WRITE_ROLE on the shared store; losing its Hub OPERATOR_ROLE is what
// retires it.
export async function manifestCutover(env: Env, dryRun: boolean) {
  const state = loadState(env)
  await requireRetirementReady(state)
  log("Retirement (DEC-2469 step 6): revokes the previous contracts' roles\n")
  const p = state.previous
  const calls: Call[] = [
    roleCall(
      state,
      "Hub OPERATOR_ROLE ✗ previous allocator",
      state.hub,
      OPERATOR_ROLE,
      p.allocator,
      "revokeRole"
    ),
    roleCall(
      state,
      "Hub OPERATOR_ROLE ✗ previous executor",
      state.hub,
      OPERATOR_ROLE,
      p.executor,
      "revokeRole"
    ),
    roleCall(
      state,
      "Hub OPERATOR_ROLE ✗ previous oracle",
      state.hub,
      OPERATOR_ROLE,
      p.inbox,
      "revokeRole"
    ),
    // Also in manifest-register with INCLUDE_MAPPING_FREEZE=1; skipped here
    // once done, and kept so the freeze cannot be missed
    mappingFreezeCall(state),
  ]
  if (p.withdrawGasPayer) {
    calls.push(
      roleCall(
        state,
        "Hub OPERATOR_ROLE ✗ WithdrawGasPayer",
        state.hub,
        OPERATOR_ROLE,
        p.withdrawGasPayer,
        "revokeRole"
      )
    )
  }
  if (state.inputs.rateLimiter) {
    calls.push(
      roleCall(
        state,
        "rate limiter CONSUMER_ROLE ✗ previous oracle",
        state.inputs.rateLimiter,
        CONSUMER_ROLE,
        p.inbox,
        "revokeRole"
      )
    )
  }
  if (p.poolDrawResolver) {
    for (const pool of state.inputs.fundingPools) {
      calls.push(
        roleCall(
          state,
          `FundingPool ${pool} RESOLVER_ROLE ✗ previous resolver`,
          pool,
          RESOLVER_ROLE,
          p.poolDrawResolver,
          "revokeRole"
        )
      )
    }
  }
  await writeManifest(state, "cutover-revoke-previous-contracts", calls, dryRun)
}

// Round 2. The TON and Gateway registrations on the new allocator, after
// manifest-activate, each in the same council manifest as its Config values.
// INCLUDE_TON=1 (after the TON timing window: the TON wallet must not be
// shared by two issuing allocators) adds TON_VM_GAS_FEE then the TON
// registration. INCLUDE_GATEWAY=1 adds the Gateway registration then the
// missing Gateway Config entries: the Gateway destination builder key is
// shared with the live Gateway builder, so the Config must not land ahead of
// the registration. Registering routes nothing (the solver keeps Gateway
// chains on the previous allocator until their override is removed), so a
// registration that lands alone is harmless. Each call has its own nonce: if
// the registration reverts, do not execute the Config writes after it, and
// regenerate the manifest. INCLUDE_MAPPING_FREEZE=1 adds the previous mapping's
// ORACLE_ROLE revoke, which manifest-cutover then skips. All are off by
// default, so each runs when its timing allows; none depends on
// manifest-cutover.
export async function manifestRegister(env: Env, dryRun: boolean) {
  const state = loadState(env)
  const includeTon = process.env.INCLUDE_TON === "1"
  const includeGateway = process.env.INCLUDE_GATEWAY === "1"
  const includeFreeze = process.env.INCLUDE_MAPPING_FREEZE === "1"
  if (!includeTon && !includeGateway && !includeFreeze) {
    throw new Error(
      "Set INCLUDE_TON=1, INCLUDE_GATEWAY=1 and/or INCLUDE_MAPPING_FREEZE=1 to choose the calls"
    )
  }
  await requireHandedOver(state)
  await requireActivated(state)
  const d = state.deployed
  const configCalls = (writes: ConfigWrite[]) => configWriteCalls(state, writes)
  const calls: Call[] = []
  for (const chain of state.chains) {
    const ton = includeTon && chain.vmType === "ton-vm"
    const gateway = includeGateway && chain.vmType === "gateway-vm"
    if (!ton && !gateway) continue
    // Only what the previous allocator serves: a retired chain is neither
    // registered nor configured again
    const served = carriedOverDepositories(state, chain)
    if (served.length === 0) {
      log(`  - ${chain.id}: not registered on the previous allocator, left out`)
      continue
    }
    const carried = { ...chain, depositories: served }
    if (ton) {
      calls.push(...configCalls(await tonConfigWrites(state, chain)))
      calls.push(
        ...registrationCalls(state, carried, d.tonVmPayloadBuilder, "TON")
      )
    }
    if (gateway) {
      calls.push(
        ...registrationCalls(
          state,
          carried,
          d.gatewayVmPayloadBuilder,
          "Gateway"
        )
      )
      calls.push(...configCalls(await gatewayConfigWrites(state, chain)))
    }
  }
  if (includeFreeze) calls.push(mappingFreezeCall(state))
  await writeManifest(state, "register-ton-and-gateway-builders", calls, dryRun)
}

// Freezes the previous GenericMapping: the previous multisig can no longer
// write it, and new entries go to the new mapping (LEGACY reads through)
function mappingFreezeCall(state: RedeployState): Call {
  return roleCall(
    state,
    "previous GenericMapping ORACLE_ROLE ✗ previous multisig",
    state.previous.genericMapping,
    ORACLE_ROLE,
    state.previous.inboxMultisig,
    "revokeRole"
  )
}

// One registration per depository of the chain
function registrationCalls(
  state: RedeployState,
  chain: ChainTarget,
  builder: Address,
  what: string
): Call[] {
  const client = publicClient(state.chainId)
  return depositoriesOf(chain).map((raw) => {
    const depository = encodedDepository(chain.vmType, raw)
    return {
      label:
        raw === chain.depository
          ? `register ${chain.id} (${what})`
          : `register ${chain.id} ${raw} (${what})`,
      to: state.deployed.allocator,
      abi: allocatorAbi,
      functionName: "setPayloadBuilder",
      args: [chain.id, depository, builder],
      skip: async () =>
        sameAddress(
          (await client.readContract({
            abi: allocatorAbi,
            address: state.deployed.allocator,
            functionName: "payloadBuilders",
            args: [chain.id, depository],
          })) as Address,
          builder
        ),
    }
  })
}
