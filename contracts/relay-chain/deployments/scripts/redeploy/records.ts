import { execFileSync } from "child_process"
import { writeFileSync } from "fs"
import type { Address } from "viem"

import {
  accessControlAbi,
  allocatorAbi,
  deploymentPath,
  loadDeployment,
  loadState,
  log,
  carriedOverDepositories,
  depositoriesOf,
  OPERATOR_ROLE,
  publicClient,
  requireChainId,
  rpcUrl,
  sameAddress,
  toDeploymentKey,
  usesStandaloneStore,
  WORKSPACE_ROOT,
  type ChainTarget,
  type Env,
  type RedeployState,
} from "./common"
import { CUTOVER_VM_TYPES, encodedDepository } from "./configure"

// Written to <env>.json under its historical key names (see DEPLOYMENT_KEYS).
// oracleIdempotencyStore is left alone in shared mode: the new inbox shares the
// live store, already recorded. In standalone mode the fresh store is recorded.
const CORE_KEYS = [
  "inboxMultisig",
  "inbox",
  "allocator",
  "executor",
  "genericMapping",
]
const coreKeys = (state: RedeployState) =>
  usesStandaloneStore(state.env)
    ? [...CORE_KEYS, "inboxIdempotencyStore"]
    : CORE_KEYS

export function updateRecords(env: Env, dryRun: boolean) {
  const state = loadState(env)
  const deployment = loadDeployment(env)
  const changes: string[] = []
  const set = (
    section: Record<string, unknown>,
    key: string,
    value: Address,
    label: string
  ) => {
    if (!value) return
    const next = value.toLowerCase()
    if (section[key] !== next)
      changes.push(`${label}: ${section[key] ?? "(none)"} → ${next}`)
    section[key] = next
  }
  for (const key of coreKeys(state)) {
    const deploymentKey = toDeploymentKey(key)
    set(
      deployment.core,
      deploymentKey,
      state.deployed[key],
      `core.${deploymentKey}`
    )
  }
  deployment.utils ??= {}
  set(
    deployment.utils,
    "poolDrawResolver",
    state.deployed.poolDrawResolver,
    "utils.poolDrawResolver"
  )
  deployment.payloadBuilders ??= {}
  for (const [key, address] of Object.entries(state.deployed)) {
    if (key.endsWith("PayloadBuilder")) {
      set(deployment.payloadBuilders, key, address, `payloadBuilders.${key}`)
    }
  }
  changes.forEach((change) => log(`  ${change}`))
  if (dryRun || changes.length === 0) return
  writeFileSync(deploymentPath(env), JSON.stringify(deployment, null, 2) + "\n")
  log(
    `\nUpdated ${deploymentPath(env)}. Run yarn prettier --write on it before committing.`
  )
}

// Every depository of every chain in the chains config must carry the new
// builder (the verifier requires the same), and every registration the
// previous allocator had must be among them. TON and Gateway are deferred
// while manifest-register has registered none of their depositories; once it
// has, every depository counts. Returns the failures and the deferred VM types.
export async function checkRegistrations(
  state: RedeployState
): Promise<{ failures: number; deferred: Set<string> }> {
  const client = publicClient(state.chainId)
  const previous = state.previousRegistrations
  const key = (chainId: string, depository: string) =>
    `${chainId}:${depository.toLowerCase()}`
  const rows: {
    chain: ChainTarget
    depository: string
    builder: Address
    ok: boolean
    // A TON or Gateway depository the previous allocator does not serve:
    // manifest-register leaves it out
    retired: boolean
  }[] = []
  for (const chain of state.chains) {
    const expected = state.deployed[chain.builderKey]
    const carried = carriedOverDepositories(state, chain)
    for (const depository of depositoriesOf(chain)) {
      const builder = (await client.readContract({
        abi: allocatorAbi,
        address: state.deployed.allocator,
        functionName: "payloadBuilders",
        args: [chain.id, encodedDepository(chain.vmType, depository)],
      })) as Address
      rows.push({
        chain,
        depository,
        builder,
        ok: !!expected && sameAddress(builder, expected),
        retired:
          CUTOVER_VM_TYPES.has(chain.vmType) && !carried.includes(depository),
      })
    }
  }
  const deferred = new Set(
    [...CUTOVER_VM_TYPES].filter(
      (vmType) =>
        rows.some((row) => row.chain.vmType === vmType && !row.retired) &&
        !rows.some(
          (row) => row.chain.vmType === vmType && !row.retired && row.ok
        )
    )
  )
  let failures = 0
  for (const { chain, depository, builder, ok, retired } of rows) {
    const label = `${chain.id} (${chain.vmType}) ${depository} → ${builder}`
    if (ok) {
      log(`  ✅ ${label}`)
    } else if (retired) {
      log(`  ⏭️  ${label} (not registered on the previous allocator: left out)`)
    } else if (deferred.has(chain.vmType)) {
      log(`  ⏳ ${label} (registered by manifest-register)`)
    } else {
      failures++
      log(`  ❌ ${label}`)
    }
  }
  if (!previous) {
    log(
      "  (no previousRegistrations in the state file: re-run inventory to compare with the previous allocator)"
    )
  }
  const checked = new Set(rows.map((row) => key(row.chain.id, row.depository)))
  for (const registration of previous ?? []) {
    if (checked.has(key(registration.chainId, registration.depository)))
      continue
    failures++
    log(
      `  ❌ ${registration.chainId} ${registration.depository}: registered on the previous allocator (${registration.builder}), not in the redeploy's chain list`
    )
  }
  return { failures, deferred }
}

// The verifier's stage allowances, from chain state, so each turns off by
// itself once its phase executes: the previous set keeps its roles until
// cutover, the new contracts' grants are pending until the new allocator holds
// Hub OPERATOR_ROLE (manifest-activate), and the deferred VM types until
// manifest-register registers them.
export const STAGE_KEYS = [
  "PREVIOUS_ORACLES",
  "PREVIOUS_CONTRACTS",
  "PENDING_HUB_GRANTS",
  "DEFERRED_BUILDER_VM_TYPES",
  "PENDING_CONFIG_ROLLOUT",
]

export async function verifierStage(
  state: RedeployState,
  deferred: Set<string>
): Promise<Record<string, string>> {
  const client = publicClient(state.chainId)
  const p = state.previous
  const replaced = (name: string) =>
    p[name] &&
    !(state.deployed[name] && sameAddress(p[name], state.deployed[name]))
      ? [p[name]]
      : []
  // The grants manifest-cutover revokes, as contract:ROLE:address, plus the
  // abandoned inboxes' grants until manifest-activate (below)
  const previousRoleGrants = [
    ...[
      ...replaced("allocator"),
      ...replaced("executor"),
      ...replaced("inbox"),
      ...(p.withdrawGasPayer ? [p.withdrawGasPayer] : []),
    ].map((address) => `hub:OPERATOR_ROLE:${address}`),
    ...(state.inputs.rateLimiter
      ? replaced("inbox").map(
          (address) => `rateLimiter:CONSUMER_ROLE:${address}`
        )
      : []),
    ...replaced("poolDrawResolver").map(
      (address) => `fundingPool:RESOLVER_ROLE:${address}`
    ),
  ]
  const hubOperator = async (account: Address) =>
    (await client.readContract({
      abi: accessControlAbi,
      address: state.hub,
      functionName: "hasRole",
      args: [OPERATOR_ROLE, account],
    })) as boolean
  const activated = await hubOperator(state.deployed.allocator)
  // An abandoned inbox keeps the roles its run granted until manifest-activate
  // revokes them (wireCalls), so they are expected only before activation
  if (!activated) {
    for (const inbox of state.abandonedInboxes ?? []) {
      previousRoleGrants.push(`hub:OPERATOR_ROLE:${inbox}`)
      if (state.inputs.rateLimiter) {
        previousRoleGrants.push(`rateLimiter:CONSUMER_ROLE:${inbox}`)
      }
      previousRoleGrants.push(`oracleIdempotencyStore:WRITE_ROLE:${inbox}`)
    }
  }
  // Until cutover revokes the previous allocator, the oracle repo's hub config
  // may still name the previous set (verifier keys)
  const rollout = (await hubOperator(p.allocator))
    ? [
        ["allocator", "allocator"],
        ["executor", "executor"],
        ["genericMapping", "genericMapping"],
        ["oracle", "inbox"],
        ["oracleMultisig", "inboxMultisig"],
      ].flatMap(([key, name]) =>
        replaced(name).map((address) => `${key}=${address}`)
      )
    : []
  return {
    // The previous oracle keeps WRITE_ROLE on the shared store. In standalone
    // mode the new inbox has a fresh store the previous oracle never shared, so
    // there is no previous-oracle holder for the verifier to expect.
    ...(!usesStandaloneStore(state.env) && replaced("inbox").length
      ? { PREVIOUS_ORACLES: p.inbox }
      : {}),
    ...(previousRoleGrants.length
      ? { PREVIOUS_CONTRACTS: previousRoleGrants.join(",") }
      : {}),
    ...(activated ? {} : { PENDING_HUB_GRANTS: "1" }),
    ...(deferred.size
      ? { DEFERRED_BUILDER_VM_TYPES: [...deferred].join(",") }
      : {}),
    ...(rollout.length ? { PENDING_CONFIG_ROLLOUT: rollout.join(",") } : {}),
  }
}

export async function verify(env: Env) {
  const state = loadState(env)
  const client = publicClient(state.chainId)
  await requireChainId(client, state.chainId)

  log("==> Registrations carried over to the new allocator")
  const { failures: missing, deferred } = await checkRegistrations(state)
  const stage = await verifierStage(state, deferred)
  log(
    `\n==> verify-deployment.ts against the updated deployment file (${
      Object.keys(stage).join(", ") || "no stage allowances"
    })`
  )
  // Only the derived stage may widen the verifier: drop inherited values
  const inherited = { ...process.env }
  for (const name of STAGE_KEYS) delete inherited[name]
  let verifierError: unknown
  try {
    execFileSync(
      "yarn",
      [
        "ts-node",
        "deployments/scripts/misc/verify-deployment.ts",
        deploymentPath(env),
      ],
      {
        cwd: WORKSPACE_ROOT,
        stdio: "inherit",
        env: {
          ...inherited,
          TS_NODE_TRANSPILE_ONLY: "1",
          RELAY_RPC_URL: rpcUrl(state.chainId),
          ...stage,
        },
      }
    )
  } catch (error) {
    verifierError = error
  }
  if (missing > 0)
    throw new Error(
      `${missing} registration(s) on the new allocator are missing or differ from the previous allocator's`
    )
  if (verifierError) {
    throw new Error(
      `verify-deployment.ts failed or could not run (see above): ${
        verifierError instanceof Error
          ? verifierError.message.split("\n")[0]
          : verifierError
      }`
    )
  }
}
