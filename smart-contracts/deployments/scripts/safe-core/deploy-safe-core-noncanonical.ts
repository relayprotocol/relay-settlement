#!/usr/bin/env ts-node
/**
 * Deploy the complete pinned Safe suite with ordinary CREATE transactions.
 * This intentionally produces noncanonical addresses and does not require the
 * Safe singleton factory.
 *
 * Required env:
 *   RPC_URL
 *   SAFE_SMART_ACCOUNT_DIR
 *   SAFE_DEPLOYMENTS_DIR_OUT
 *   PK, DEPLOYER_PRIVATE_KEY, or MNEMONIC
 *
 * Optional env:
 *   HUB_CONTRACTS_PATH            Target environment's hub contracts file
 *   SAFE_CORE_GAS_MULTIPLIER_BPS  Gas estimate multiplier (default 20000, 2x)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs"
import { dirname, resolve } from "path"
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getContractAddress,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { requireEnv, REQUIRED_SAFE_CORE_CONTRACTS } from "./safe-core-common"

const artifactPaths: Record<
  (typeof REQUIRED_SAFE_CORE_CONTRACTS)[number],
  string
> = {
  CompatibilityFallbackHandler:
    "contracts/handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json",
  CreateCall: "contracts/libraries/CreateCall.sol/CreateCall.json",
  ExtensibleFallbackHandler:
    "contracts/handler/ExtensibleFallbackHandler.sol/ExtensibleFallbackHandler.json",
  MultiSend: "contracts/libraries/MultiSend.sol/MultiSend.json",
  MultiSendCallOnly:
    "contracts/libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json",
  Safe: "contracts/Safe.sol/Safe.json",
  SafeL2: "contracts/SafeL2.sol/SafeL2.json",
  SafeMigration: "contracts/libraries/SafeMigration.sol/SafeMigration.json",
  SafeProxyFactory:
    "contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json",
  SafeToL2Setup: "contracts/libraries/SafeToL2Setup.sol/SafeToL2Setup.json",
  SignMessageLib: "contracts/libraries/SignMessageLib.sol/SignMessageLib.json",
  SimulateTxAccessor:
    "contracts/accessors/SimulateTxAccessor.sol/SimulateTxAccessor.json",
  TokenCallbackHandler:
    "contracts/handler/TokenCallbackHandler.sol/TokenCallbackHandler.json",
}

const deploymentOrder = [
  "SimulateTxAccessor",
  "SafeProxyFactory",
  "TokenCallbackHandler",
  "CompatibilityFallbackHandler",
  "ExtensibleFallbackHandler",
  "CreateCall",
  "MultiSend",
  "MultiSendCallOnly",
  "SignMessageLib",
  "SafeToL2Setup",
  "Safe",
  "SafeL2",
  "SafeMigration",
] as const

type DeploymentName = (typeof deploymentOrder)[number]

const migrationConstructorAbi = parseAbi([
  "constructor(address safeSingleton, address safeL2Singleton, address fallbackHandler)",
])

type Artifact = {
  abi: Abi
  bytecode: Hex
  contractName: string
  deployedBytecode: Hex
  sourceName: string
}

type ArtifactRecord = {
  artifact: Artifact
  immutableReferences: Record<string, { length: number; start: number }[]>
  metadata: string
}

type DebugArtifact = {
  buildInfo: string
}

type BuildInfo = {
  output: {
    contracts: Record<
      string,
      Record<
        string,
        {
          evm: {
            deployedBytecode: {
              immutableReferences: Record<
                string,
                { length: number; start: number }[]
              >
            }
          }
          metadata: string
        }
      >
    >
  }
}

function deploymentAccount() {
  const privateKey = process.env.PK ?? process.env.DEPLOYER_PRIVATE_KEY
  if (privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("PK/DEPLOYER_PRIVATE_KEY must be a 32-byte hex value")
    }
    return privateKeyToAccount(privateKey as Hex)
  }
  if (process.env.MNEMONIC) {
    return mnemonicToAccount(process.env.MNEMONIC)
  }
  throw new Error("set PK, DEPLOYER_PRIVATE_KEY, or MNEMONIC")
}

function gasMultiplierBps(): bigint {
  const value = process.env.SAFE_CORE_GAS_MULTIPLIER_BPS ?? "20000"
  if (!/^\d+$/.test(value) || BigInt(value) < 10000n) {
    throw new Error("SAFE_CORE_GAS_MULTIPLIER_BPS must be at least 10000")
  }
  return BigInt(value)
}

function readArtifact(
  upstreamDirectory: string,
  name: (typeof REQUIRED_SAFE_CORE_CONTRACTS)[number]
): ArtifactRecord {
  const artifactPath = resolve(
    upstreamDirectory,
    "build",
    "artifacts",
    artifactPaths[name]
  )
  if (!existsSync(artifactPath)) {
    throw new Error(`Safe artifact not found: ${artifactPath}`)
  }
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Artifact
  if (!artifact.bytecode || artifact.bytecode === "0x") {
    throw new Error(`${name} artifact has no deployment bytecode`)
  }

  const debugPath = artifactPath.replace(/\.json$/, ".dbg.json")
  const debugArtifact = JSON.parse(
    readFileSync(debugPath, "utf8")
  ) as DebugArtifact
  const buildInfoPath = resolve(dirname(debugPath), debugArtifact.buildInfo)
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as BuildInfo
  const compilerOutput =
    buildInfo.output.contracts[artifact.sourceName]?.[artifact.contractName]
  if (!compilerOutput?.metadata) {
    throw new Error(`${name} artifact has no compiler metadata`)
  }
  return {
    artifact,
    immutableReferences:
      compilerOutput.evm.deployedBytecode.immutableReferences ?? {},
    metadata: compilerOutput.metadata,
  }
}

function reservedSafeAddresses(
  targetPath: string | undefined,
  chainId: number
): Map<string, string> {
  const reserved = new Map<string, string>()
  if (!targetPath) {
    return reserved
  }
  const absoluteTarget = resolve(targetPath)
  const directory = dirname(absoluteTarget)
  for (const file of readdirSync(directory)) {
    const path = resolve(directory, file)
    if (!file.endsWith(".json") || path === absoluteTarget) {
      continue
    }
    const deployment = JSON.parse(readFileSync(path, "utf8")) as {
      chainId?: unknown
      safe?: Record<string, unknown>
    }
    if (deployment.chainId?.toString() !== chainId.toString()) {
      continue
    }
    for (const value of Object.values(deployment.safe ?? {})) {
      if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
        reserved.set(value.toLowerCase(), file)
      }
    }
  }
  return reserved
}

function runtimeCodeMatches(code: Hex, record: ArtifactRecord): boolean {
  const normalizedCode = hexToBytes(code)
  for (const references of Object.values(record.immutableReferences)) {
    for (const { length, start } of references) {
      normalizedCode.fill(0, start, start + length)
    }
  }
  return (
    keccak256(normalizedCode) === keccak256(record.artifact.deployedBytecode)
  )
}

function writeDeployment(
  outputDirectory: string,
  name: DeploymentName,
  record: ArtifactRecord,
  address: Address,
  constructorArguments: Address[],
  transactionHash?: Hex
): void {
  writeFileSync(
    resolve(outputDirectory, `${name}.json`),
    `${JSON.stringify(
      {
        abi: record.artifact.abi,
        address,
        args: constructorArguments,
        bytecode: record.artifact.bytecode,
        deployedBytecode: record.artifact.deployedBytecode,
        metadata: record.metadata,
        ...(transactionHash ? { transactionHash } : {}),
      },
      null,
      2
    )}\n`
  )
}

async function main() {
  const rpcUrl = requireEnv("RPC_URL")
  const upstreamDirectory = resolve(requireEnv("SAFE_SMART_ACCOUNT_DIR"))
  const outputDirectory = resolve(requireEnv("SAFE_DEPLOYMENTS_DIR_OUT"))
  const account = deploymentAccount()
  const multiplierBps = gasMultiplierBps()
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) })
  const chainId = await publicClient.getChainId()
  const reservedAddresses = reservedSafeAddresses(
    process.env.HUB_CONTRACTS_PATH,
    chainId
  )
  const artifacts = Object.fromEntries(
    deploymentOrder.map((name) => [name, readArtifact(upstreamDirectory, name)])
  ) as Record<DeploymentName, ArtifactRecord>

  mkdirSync(outputDirectory, { recursive: true })

  console.log(`Deploying noncanonical Safe core suite on chain ${chainId}`)
  console.log(`  deployer: ${account.address}`)
  console.log(`  gas estimate multiplier: ${multiplierBps} bps`)
  const addresses: Partial<Record<DeploymentName, Address>> = {}

  // Reuse valid deployment metadata when an external Safe checkout was kept
  // after an interrupted run.
  let encounteredMissingFile = false
  for (const name of deploymentOrder) {
    const outputPath = resolve(outputDirectory, `${name}.json`)
    if (!existsSync(outputPath)) {
      encounteredMissingFile = true
      continue
    }
    if (encounteredMissingFile) {
      throw new Error(`deployment metadata is not a contiguous prefix: ${name}`)
    }
    const existing = JSON.parse(readFileSync(outputPath, "utf8")) as {
      address?: unknown
    }
    if (
      typeof existing.address !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(existing.address)
    ) {
      throw new Error(`invalid existing ${name} deployment metadata`)
    }
    const address = existing.address as Address
    const code = await publicClient.getCode({ address })
    if (!code || code === "0x") {
      throw new Error(`existing ${name} deployment has no code at ${address}`)
    }
    if (!runtimeCodeMatches(code, artifacts[name])) {
      throw new Error(`existing ${name} runtime does not match at ${address}`)
    }
    addresses[name] = address
    console.log(`  ${name}: reusing ${address}`)
  }

  // The wrapper normally uses a temporary checkout, so its metadata disappears
  // after failure. Scan recent deployer nonces for a contiguous suite prefix and
  // regenerate its metadata. Gaps caused by reverted or unrelated transactions
  // after that prefix do not force already deployed contracts to be redeployed.
  if (Object.keys(addresses).length === 0) {
    const currentNonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    })
    const firstNonce = Math.max(0, currentNonce - 64)
    for (
      let startNonce = currentNonce - 1;
      startNonce >= firstNonce;
      startNonce--
    ) {
      const recovered: Partial<Record<DeploymentName, Address>> = {}
      for (
        let index = 0;
        index < deploymentOrder.length && startNonce + index < currentNonce;
        index++
      ) {
        const name = deploymentOrder[index]
        const address = getContractAddress({
          from: account.address,
          nonce: BigInt(startNonce + index),
        })
        const code = await publicClient.getCode({ address })
        const runtimeMatches =
          code && code !== "0x" && runtimeCodeMatches(code, artifacts[name])
        if (!runtimeMatches) {
          break
        }
        recovered[name] = address
      }
      const prefixLength = Object.keys(recovered).length
      if (prefixLength === 0) {
        continue
      }
      const reservedAddress = Object.values(recovered).find((address) =>
        reservedAddresses.has(address.toLowerCase())
      )
      if (reservedAddress) {
        console.log(
          `  not reusing prior suite recorded in ${reservedAddresses.get(reservedAddress.toLowerCase())}`
        )
        break
      }

      Object.assign(addresses, recovered)
      console.log(`  recovered ${prefixLength} prior deployments from chain`)
      for (let index = 0; index < prefixLength; index++) {
        const name = deploymentOrder[index]
        const address = addresses[name]!
        const constructorArguments =
          name === "SafeMigration"
            ? [
                addresses.Safe!,
                addresses.SafeL2!,
                addresses.CompatibilityFallbackHandler!,
              ]
            : []
        writeDeployment(
          outputDirectory,
          name,
          artifacts[name],
          address,
          constructorArguments
        )
        console.log(`  ${name}: reusing ${address}`)
      }
      break
    }
  }

  for (const name of deploymentOrder) {
    if (addresses[name]) {
      continue
    }
    const record = artifacts[name]
    const constructorArguments =
      name === "SafeMigration"
        ? [
            addresses.Safe!,
            addresses.SafeL2!,
            addresses.CompatibilityFallbackHandler!,
          ]
        : []
    const data =
      name === "SafeMigration"
        ? encodeDeployData({
            abi: migrationConstructorAbi,
            args: constructorArguments as [Address, Address, Address],
            bytecode: record.artifact.bytecode,
          })
        : record.artifact.bytecode
    const estimatedGas = await publicClient.estimateGas({
      account: account.address,
      data,
    })
    const gas = (estimatedGas * multiplierBps + 9999n) / 10000n
    const transactionHash = await walletClient.sendTransaction({
      chain: null,
      data,
      gas,
    })
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    })
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`${name} deployment failed: ${transactionHash}`)
    }
    addresses[name] = receipt.contractAddress

    writeDeployment(
      outputDirectory,
      name,
      record,
      receipt.contractAddress,
      constructorArguments,
      transactionHash
    )
    console.log(
      `  ${name}: ${receipt.contractAddress} (${transactionHash}, gas limit ${gas})`
    )
  }

  console.log("Noncanonical Safe core deployment complete")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
