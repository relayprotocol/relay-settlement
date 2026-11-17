import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"

import {
  DEFAULT_RELAY_RPCS,
  SECURITY_COUNCIL_BY_ENV,
} from "../misc/verify-deployment/constants"
import type { DeploymentFile } from "../misc/verify-deployment/constants"

export const WORKSPACE_ROOT = join(__dirname, "../../..")
export const REPO_ROOT = join(WORKSPACE_ROOT, "../..")

export type Env = "dev" | "stag" | "prod" | "test"
const ENVS: Env[] = ["dev", "stag", "prod", "test"]

// Envs whose live oracle has no shared idempotency store (a legacy oracle
// without IDEMPOTENCY_STORE, already off the hub), so the redeploy deploys a
// fresh standalone store for the new inbox instead of sharing one. No replay
// protection is shared with the legacy oracle, which is safe only because it
// can no longer execute: inventory refuses standalone mode while it still holds
// Hub OPERATOR_ROLE.
export const STANDALONE_STORE_ENVS = new Set<Env>(["test"])
export const usesStandaloneStore = (env: Env) => STANDALONE_STORE_ENVS.has(env)

// The idempotency store the new inbox uses: in standalone mode, the freshly
// deployed store; otherwise always the live oracle's shared store recorded by
// inventory, even if the state carries a deployed store from another run.
export const resolveIdempotencyStore = (
  state: RedeployState
): Address | undefined =>
  state.inputs.standaloneIdempotencyStore
    ? state.deployed.inboxIdempotencyStore
    : state.inputs.idempotencyStore

export const role = (name: string): Hex => keccak256(toHex(name))
export const ADMIN_ROLE = role("ADMIN_ROLE")
export const ORACLE_ROLE = role("ORACLE_ROLE")
export const OPERATOR_ROLE = role("OPERATOR_ROLE")
export const WRITE_ROLE = role("WRITE_ROLE")
export const CONSUMER_ROLE = role("CONSUMER_ROLE")
export const RESOLVER_ROLE = role("RESOLVER_ROLE")

// Every redeployed contract, in deploy order. TON reads ALLOCATOR, so it must
// come after the allocator; the other builders only take CONFIG. The
// idempotency store is not redeployed: the new inbox shares the live one.
export const CORE_CONTRACTS = [
  "inboxMultisig",
  "inbox",
  "allocator",
  "executor",
  "poolDrawResolver",
  "genericMapping",
] as const

// <env>.json still uses the pre-RelayInbox key names, which the verifier and
// the multisig-tools generators read. The tool names things after the
// contracts and translates only when reading or writing that file.
export const DEPLOYMENT_KEYS: Record<string, string> = {
  inbox: "oracle",
  inboxMultisig: "oracleMultisig",
  inboxIdempotencyStore: "oracleIdempotencyStore",
}
export const toDeploymentKey = (name: string) => DEPLOYMENT_KEYS[name] ?? name

export function fromDeploymentKeys<T>(
  flat: Record<string, T>
): Record<string, T> {
  const renamed = Object.fromEntries(
    Object.entries(DEPLOYMENT_KEYS).map(([name, key]) => [key, name])
  )
  return Object.fromEntries(
    Object.entries(flat).map(([key, value]) => [renamed[key] ?? key, value])
  )
}

export type ChainTarget = {
  id: string
  vmType: string
  // The primary depository; Lighter and Gateway Config values use it
  depository: string
  // Every depository the allocator registers the builder under: the primary
  // one, then the chain's additionalDepositories (none for the families the
  // verifier treats as single-depository). Absent in older state files.
  depositories?: string[]
  builderKey: string
  // gateway-vm only: the chain whose Gateway depository funds withdrawals
  gatewaySource?: string
}

// Everything the redeploy reads from the live environment, then what it
// deployed and which steps already ran. Written to deployments/redeploy/<env>.json
// so every phase can resume.
export type RedeployState = {
  env: Env
  chainId: number
  inventoriedAt: string
  hub: Address
  config: Address
  council: Address
  previous: Record<string, Address>
  inputs: {
    // The live oracle's idempotency store, which the new inbox shares. Absent
    // in standalone mode (standaloneIdempotencyStore), where --phase deploy
    // deploys a fresh store for the new inbox instead.
    idempotencyStore?: Address
    // Set when the env's live oracle has no shared store (e.g. a legacy oracle
    // without IDEMPOTENCY_STORE and without ORACLE_ROLE on the hub): the new
    // inbox gets a freshly deployed standalone store with no replay sharing.
    standaloneIdempotencyStore?: boolean
    multisigSigners: Address[]
    multisigThreshold: string
    rateLimiter?: Address
    feeCalculator?: Address
    fundingPools: Address[]
    bitcoinChangeScript?: Hex
    xrpSigningPubkey?: Hex
    hederaTokenNum?: string
    hyperliquidSignatureChainId?: string
    hyperliquidChain?: string
    tonChainId?: string
    tonSubwalletId?: string
    tonTimeout?: string
  }
  chains: ChainTarget[]
  // The previous allocator's non-zero registrations, which the new allocator
  // must all carry over. Absent in older state files.
  previousRegistrations?: Registration[]
  deployed: Record<string, Address>
  steps: Record<string, string>
  // Inboxes from an earlier, abandoned run of this redeploy. manifest-activate
  // revokes their Hub OPERATOR_ROLE and rate limiter CONSUMER_ROLE.
  abandonedInboxes?: Address[]
}

export type Registration = {
  chainId: string
  depository: string
  builder: Address
}

export const depositoriesOf = (chain: ChainTarget) =>
  chain.depositories ?? [chain.depository]

// EVM depositories compare case-insensitively; others (base58, TON raw
// addresses) exactly
const sameDepository = (a: string, b: string) =>
  a === b || (a.startsWith("0x") && a.toLowerCase() === b.toLowerCase())

// The depositories of a TON or Gateway chain that round 2 carries over: those
// the previous allocator serves. A chain it no longer serves, such as a
// Gateway source the council retired (prod polygon-gateway, manifest 086),
// stays unregistered, so the redeploy never re-enables it. Without a recorded
// inventory, every depository counts.
export function carriedOverDepositories(
  state: Pick<RedeployState, "previousRegistrations">,
  chain: ChainTarget
): string[] {
  const all = depositoriesOf(chain)
  const previous = state.previousRegistrations
  if (!previous) return all
  return all.filter((depository) =>
    previous.some(
      (registration) =>
        registration.chainId === chain.id &&
        sameDepository(registration.depository, depository)
    )
  )
}

export function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) continue
    const [key, inline] = arg.slice(2).split("=", 2)
    const next = argv[i + 1]
    if (inline !== undefined) flags.set(key, inline)
    else if (next && !next.startsWith("--")) flags.set(key, argv[++i])
    else flags.set(key, true)
  }
  const env = flags.get("env")
  if (typeof env !== "string" || !ENVS.includes(env as Env)) {
    throw new Error(`--env must be one of ${ENVS.join(", ")}`)
  }
  const phase = flags.get("phase")
  if (typeof phase !== "string") throw new Error("--phase is required")
  return { env: env as Env, phase, dryRun: flags.has("dry-run"), flags }
}

export const deploymentPath = (env: Env) =>
  join(WORKSPACE_ROOT, "deployments/contracts", `${env}.json`)
export const statePath = (env: Env) =>
  join(WORKSPACE_ROOT, "deployments/redeploy", `${env}.json`)

export function loadDeployment(env: Env): DeploymentFile {
  return JSON.parse(readFileSync(deploymentPath(env), "utf8"))
}

export function loadState(env: Env): RedeployState {
  const path = statePath(env)
  if (!existsSync(path)) {
    throw new Error(`No redeploy state for ${env}: run --phase inventory first`)
  }
  return JSON.parse(readFileSync(path, "utf8"))
}

export function saveState(state: RedeployState) {
  const path = statePath(state.env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n")
}

export function rpcUrl(chainId: number): string {
  const url = process.env.RELAY_RPC_URL ?? DEFAULT_RELAY_RPCS[chainId]
  if (!url) throw new Error(`Set RELAY_RPC_URL for hub chain ${chainId}`)
  return url
}

export function publicClient(chainId: number): PublicClient {
  return createPublicClient({ transport: http(rpcUrl(chainId)) })
}

export function deployerAccount() {
  const key = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY
  if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY")
  return privateKeyToAccount(key as Hex)
}

export function walletClient(chainId: number) {
  return createWalletClient({
    account: deployerAccount(),
    transport: http(rpcUrl(chainId)),
  })
}

export function councilFor(env: Env): Address {
  const council = SECURITY_COUNCIL_BY_ENV[env]
  if (!council) throw new Error(`No security council for ${env}`)
  return council
}

export async function requireChainId(client: PublicClient, expected: number) {
  const actual = await client.getChainId()
  if (actual !== expected) {
    throw new Error(
      `RPC reports chain ${actual}, deployment file expects ${expected}. Wrong RPC, or the devnet chain id drifted`
    )
  }
}

export const accessControlAbi = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function renounceRole(bytes32 role, address account)",
])

export const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
])

export const allocatorAbi = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
  "function payloadBuilders(string chainId, bytes depository) view returns (address)",
])

// Config's setters are onlyAllocatorOwner: its admin is allocator().owner()
export const configAbi = parseAbi([
  "function allocator() view returns (address)",
  "function setAllocator(address newAllocator)",
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
])

export const sameAddress = (a: Address, b: Address) =>
  a.toLowerCase() === b.toLowerCase()

export const inboxAbi = parseAbi([
  "function addRateLimiter(address rateLimiter)",
  "function addFeeCalculator(address feeCalculator)",
  "function isRateLimiter(address rateLimiter) view returns (bool)",
  "function isFeeCalculator(address feeCalculator) view returns (bool)",
  "function IDEMPOTENCY_STORE() view returns (address)",
  // Also on the idempotency store itself
  "function isExecuted(bytes32 idempotencyKey) view returns (bool)",
])

export const multisigAbi = parseAbi([
  "function getSigners() view returns (address[])",
  "function threshold() view returns (uint256)",
])

export const builderAbi = parseAbi([
  "function allocatorChangeScript() view returns (bytes)",
  "function SIGNING_PUBKEY_PREFIX() view returns (bytes1)",
  "function SIGNING_PUBKEY_BODY() view returns (bytes32)",
  "function TOKEN_NUM() view returns (uint64)",
  "function SIGNATURE_CHAIN_ID() view returns (uint64)",
  "function hyperliquidChain() view returns (string)",
  "function SUBWALLET_ID() view returns (uint32)",
  "function TIMEOUT() view returns (uint32)",
  "function getGasFeeKey(string chainId) view returns (bytes32)",
])

// getCode returns undefined, "0x" or "0x0" for an address without code
export const hasCode = (code: string | undefined) =>
  !!code && !/^0x0*$/.test(code)

export function log(message: string) {
  console.log(message)
}
