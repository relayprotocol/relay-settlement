import { readFileSync } from "fs"
import { isAddress, parseAbi, zeroAddress } from "viem"
import { networks } from "@relay-protocol/settlement-networks"
import { GATEWAY_CHAINS } from "../configs/gateway-vm"

export type RouterTuple = {
  chain: string
  depository: `0x${string}`
  router: `0x${string}`
}
export type RouterRollout = {
  retiredRouters?: RouterTuple[]
  gatewayDestinations?: RouterTuple[]
}

const GATEWAY_SLUGS = new Set<string>(GATEWAY_CHAINS.map((chain) => chain.name))

// Retired entries are independent of multicallRouters: keep them after replacing
// current addresses so future verification continues checking old permissions.
export function resolveRouterRollout(input: RouterRollout = {}) {
  const retiredRouters = input.retiredRouters ?? []
  const gatewayDestinations = input.gatewayDestinations ?? []
  for (const tuple of gatewayDestinations) {
    if (!GATEWAY_SLUGS.has(tuple.chain)) {
      throw new Error(`${tuple.chain}: not a Gateway destination chain`)
    }
  }
  for (const tuple of [...retiredRouters, ...gatewayDestinations]) {
    const net = networks[tuple.chain]
    if (!net || net.family !== "ethereum-vm" || net.chainId <= 0n) {
      throw new Error(
        `${tuple.chain}: expected an ethereum-vm destination domain`
      )
    }
    for (const field of ["depository", "router"] as const) {
      if (
        !isAddress(tuple[field]) ||
        tuple[field].toLowerCase() === zeroAddress
      ) {
        throw new Error(`${tuple.chain}: invalid ${field}`)
      }
    }
  }
  const identity = (tuple: RouterTuple) =>
    `${tuple.chain}:${tuple.depository.toLowerCase()}:${tuple.router.toLowerCase()}`
  if (
    gatewayDestinations.some((tuple) =>
      retiredRouters.some((old) => identity(old) === identity(tuple))
    )
  ) {
    throw new Error("Router tuple cannot be both active and retired")
  }
  return { gatewayDestinations, retiredRouters }
}

// Every recorded router is checked, whatever chain subset a helper was asked to
// process, because retired tuples are always written and verified.
export function assertRetiredRoutersInactive(
  rollout: { retiredRouters: RouterTuple[] },
  multicallRouters: Record<string, string> | undefined,
  env: string
) {
  for (const [slug, router] of Object.entries(multicallRouters ?? {})) {
    const depository = networks[slug]?.contracts?.[env]?.depository
    if (
      rollout.retiredRouters.some(
        (old) =>
          old.chain === slug &&
          old.depository.toLowerCase() === depository?.toLowerCase() &&
          old.router.toLowerCase() === router.toLowerCase()
      )
    ) {
      throw new Error(`${slug}: Router tuple cannot be both active and retired`)
    }
  }
}

// GatewayVmPayloadBuilder resolves a chain's destination builder from this Config
// key; a Gateway router allowlisted behind another builder would receive bare
// transfers, so callers gate the allowlist write and its verification on it.
export const gatewayDestinationBuilderAbi = parseAbi([
  "function getDestinationBuilderKey(string chainId) view returns (bytes32)",
  "function getDestinationDepositoryKey(string chainId) view returns (bytes32)",
])

// ConfigValueNotSet must be in the ABI so viem can name the revert and an unset
// key reads as undefined instead of a hard failure.
export const configReadAbi = parseAbi([
  "function getConfigValue(bytes32 key) view returns (bytes32)",
  "error ConfigValueNotSet(bytes32 key)",
])

export async function readConfigWord(
  client: { readContract: (_request: never) => Promise<unknown> },
  config: `0x${string}`,
  key: `0x${string}`
): Promise<`0x${string}` | undefined> {
  try {
    return (await client.readContract({
      abi: configReadAbi,
      address: config,
      args: [key],
      functionName: "getConfigValue",
    } as never)) as `0x${string}`
  } catch (error) {
    // Walk the cause chain by shape: callers hold different viem copies, so
    // instanceof checks against this module's classes would not match.
    for (let cause: unknown = error; cause; ) {
      const { data } = cause as { data?: { errorName?: string } }
      if (data?.errorName === "ConfigValueNotSet") return undefined
      cause = (cause as { cause?: unknown }).cause
    }
    throw error
  }
}

export async function readDestinationBuilderKey(
  client: { readContract: (_request: never) => Promise<unknown> },
  gatewayBuilder: `0x${string}`,
  chain: string
): Promise<`0x${string}`> {
  return (await client.readContract({
    abi: gatewayDestinationBuilderAbi,
    address: gatewayBuilder,
    args: [chain],
    functionName: "getDestinationBuilderKey",
  } as never)) as `0x${string}`
}

const configuredAddressMismatch = (
  label: string,
  configured: `0x${string}` | undefined,
  expected: `0x${string}`
): string | undefined => {
  const word = `0x${expected.slice(2).padStart(64, "0")}`
  if (configured?.toLowerCase() === word.toLowerCase()) return undefined
  return `${label} is ${configured ?? "unset"}, expected ${word}`
}

// Returns why the configured destination builder word is not `destinationBuilder`,
// or undefined when it is.
export function destinationBuilderMismatch(
  configured: `0x${string}` | undefined,
  destinationBuilder: `0x${string}`
): string | undefined {
  return configuredAddressMismatch(
    "Gateway destination builder",
    configured,
    destinationBuilder
  )
}

// The Gateway destination depository is the address that receives DEPOSITORY_ROLE
// on the router, so a recorded tuple must name the one Config resolves.
export async function readDestinationDepositoryKey(
  client: { readContract: (_request: never) => Promise<unknown> },
  gatewayBuilder: `0x${string}`,
  chain: string
): Promise<`0x${string}`> {
  return (await client.readContract({
    abi: gatewayDestinationBuilderAbi,
    address: gatewayBuilder,
    args: [chain],
    functionName: "getDestinationDepositoryKey",
  } as never)) as `0x${string}`
}

export function destinationDepositoryMismatch(
  configured: `0x${string}` | undefined,
  depository: `0x${string}`
): string | undefined {
  return configuredAddressMismatch(
    "Gateway destination depository",
    configured,
    depository
  )
}

export function loadRouterRollout(recorded?: RouterRollout) {
  const extra: RouterRollout = process.env.ROUTER_ROLLOUT_FILE
    ? JSON.parse(readFileSync(process.env.ROUTER_ROLLOUT_FILE, "utf8"))
    : {}
  return resolveRouterRollout({
    gatewayDestinations: [
      ...(recorded?.gatewayDestinations ?? []),
      ...(extra.gatewayDestinations ?? []),
    ],
    retiredRouters: [
      ...(recorded?.retiredRouters ?? []),
      ...(extra.retiredRouters ?? []),
    ],
  })
}
