import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { getAddress, type Address } from "viem"

export const SAFE_SMART_ACCOUNT_VERSION = "1.5.0"
export const SAFE_SMART_ACCOUNT_COMMIT = [
  "dc437e8fba8b4805d76b",
  "cbd1c668c9fd3d1e83be",
].join("")
export const SAFE_SMART_ACCOUNT_REPOSITORY =
  "https://github.com/safe-fndn/safe-smart-account.git"

export const REQUIRED_SAFE_CORE_CONTRACTS = [
  "CompatibilityFallbackHandler",
  "CreateCall",
  "ExtensibleFallbackHandler",
  "MultiSend",
  "MultiSendCallOnly",
  "Safe",
  "SafeL2",
  "SafeMigration",
  "SafeProxyFactory",
  "SafeToL2Setup",
  "SignMessageLib",
  "SimulateTxAccessor",
  "TokenCallbackHandler",
] as const

export type SafeCoreContractName = (typeof REQUIRED_SAFE_CORE_CONTRACTS)[number]

export const SAFE_CORE_DEPLOYMENT_KEYS: Record<SafeCoreContractName, string> = {
  CompatibilityFallbackHandler: "compatibilityFallbackHandler",
  CreateCall: "createCall",
  ExtensibleFallbackHandler: "extensibleFallbackHandler",
  MultiSend: "multiSend",
  MultiSendCallOnly: "multiSendCallOnly",
  Safe: "safeSingleton",
  SafeL2: "safeL2Singleton",
  SafeMigration: "safeMigration",
  SafeProxyFactory: "safeProxyFactory",
  SafeToL2Setup: "safeToL2Setup",
  SignMessageLib: "signMessageLib",
  SimulateTxAccessor: "simulateTxAccessor",
  TokenCallbackHandler: "tokenCallbackHandler",
}

export type SafeCoreDeployment = {
  chainId: string
  contracts: Record<SafeCoreContractName, { address: Address }>
}

type HardhatDeployment = {
  address?: unknown
}

type HubContractsFile = {
  chainId?: unknown
  safe?: Record<string, unknown>
  [key: string]: unknown
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`set ${name}`)
  }
  return value
}

export function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an address`)
  }
  try {
    return getAddress(value)
  } catch {
    throw new Error(`${label} must be a valid EVM address`)
  }
}

export function readHardhatDeployments(
  directory: string
): Record<string, { address: Address }> {
  const absoluteDirectory = resolve(directory)
  if (!existsSync(absoluteDirectory)) {
    throw new Error(`Safe deployment directory not found: ${absoluteDirectory}`)
  }

  const deployments: Record<string, { address: Address }> = {}
  for (const file of readdirSync(absoluteDirectory).sort()) {
    if (!file.endsWith(".json")) {
      continue
    }
    const name = file.slice(0, -".json".length)
    const parsed = JSON.parse(
      readFileSync(resolve(absoluteDirectory, file), "utf8")
    ) as HardhatDeployment
    deployments[name] = {
      address: asAddress(parsed.address, `${file}.address`),
    }
  }

  assertRequiredContracts(deployments)
  return deployments
}

export function readSafeCoreDeployment(path: string): SafeCoreDeployment {
  const absolutePath = resolve(path)
  if (!existsSync(absolutePath)) {
    throw new Error(`Hub contracts file not found: ${absolutePath}`)
  }
  const deployment = JSON.parse(
    readFileSync(absolutePath, "utf8")
  ) as HubContractsFile
  if (typeof deployment.chainId !== "number") {
    throw new Error(`Invalid chainId in ${absolutePath}`)
  }
  if (!deployment.safe || typeof deployment.safe !== "object") {
    throw new Error(`Safe deployment is missing from ${absolutePath}`)
  }

  const contracts = {} as SafeCoreDeployment["contracts"]
  for (const name of REQUIRED_SAFE_CORE_CONTRACTS) {
    const key = SAFE_CORE_DEPLOYMENT_KEYS[name]
    contracts[name] = {
      address: asAddress(deployment.safe[key], `safe.${key}`),
    }
  }
  return { chainId: deployment.chainId.toString(), contracts }
}

export function writeSafeCoreDeployment(
  path: string,
  chainId: bigint | number,
  contracts: Record<string, { address: Address }>
): void {
  const absolutePath = resolve(path)
  if (!existsSync(absolutePath)) {
    throw new Error(`Hub contracts file not found: ${absolutePath}`)
  }
  const deployment = JSON.parse(
    readFileSync(absolutePath, "utf8")
  ) as HubContractsFile
  if (deployment.chainId?.toString() !== chainId.toString()) {
    throw new Error(
      `Hub contracts chain ${String(deployment.chainId)} does not match RPC chain ${chainId}`
    )
  }
  assertRequiredContracts(contracts)

  deployment.safe = Object.fromEntries(
    REQUIRED_SAFE_CORE_CONTRACTS.map((name) => [
      SAFE_CORE_DEPLOYMENT_KEYS[name],
      contracts[name].address.toLowerCase(),
    ])
  )
  writeFileSync(absolutePath, `${JSON.stringify(deployment, null, 2)}\n`)
}

export function assertRequiredContracts(
  contracts: Record<string, unknown>
): void {
  const missing = REQUIRED_SAFE_CORE_CONTRACTS.filter(
    (name) => contracts[name] === undefined
  )
  if (missing.length > 0) {
    throw new Error(`Safe core deployment is incomplete: ${missing.join(", ")}`)
  }
}

export function defaultHubContractsPath(chainId: bigint | number): string {
  const directory = resolve(__dirname, "..", "..", "contracts")
  const matches = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => resolve(directory, file))
    .filter((path) => {
      const deployment = JSON.parse(
        readFileSync(path, "utf8")
      ) as HubContractsFile
      return deployment.chainId?.toString() === chainId.toString()
    })
  if (matches.length === 0) {
    throw new Error(`No hub contracts file matches chain ${chainId}`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Chain ${chainId} matches multiple hub contracts files: ${matches.join(", ")}. ` +
        "Set HUB_CONTRACTS_PATH to the intended environment."
    )
  }
  return matches[0]
}
