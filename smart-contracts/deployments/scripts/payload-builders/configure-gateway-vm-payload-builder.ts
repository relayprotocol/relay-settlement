#!/usr/bin/env ts-node
/**
 * Configure one GatewayVmPayloadBuilder for a Gateway chain/bucket.
 *
 * Configured chains:
 *   arbitrum, avalanche, base, ethereum, hyperevm, optimism, polygon, sei,
 *   sonic, unichain, worldchain
 *
 * Actions:
 *   1. RelayAllocator.setPayloadBuilder(SOURCE_CHAIN-gateway, EVM-encoded DEPOSITORY, PAYLOAD_BUILDER)
 *   2. Config.setConfigValues(...) for this payload builder's namespaced keys:
 *      - Circle domain per Relay chain id
 *      - fixed Circle gas fee for this Gateway chain
 *      - source native USDC address for this Gateway chain
 *      - destination native USDC address per Relay destination chain
 *      - per-chain EVM destination payload builder for this Gateway chain
 *      - per-chain Gateway depository
 *      - Gateway allocator allowlist
 *
 * Required env vars:
 *   RPC_URL                       RPC for the chain hosting RelayAllocator/Config
 *   PRIVATE_KEY                   RelayAllocator owner key (not needed with DRY_RUN=1)
 *   ALLOCATOR                     RelayAllocator contract address
 *   CONFIG                        Config contract address
 *   PAYLOAD_BUILDER               GatewayVmPayloadBuilder contract address
 *   DESTINATION_PAYLOAD_BUILDER   GatewayEthereumVmDestinationPayloadBuilder address
 *   DEPOSITORY                    RelayGatewayDepository address shared by the EVM chains
 *   SOURCE_CHAIN                  Source chain for this Gateway chain
 *   GATEWAY_ALLOCATORS            Comma-separated selectable Gateway allocator addresses
 *
 * Optional env vars:
 *   GAS_FEE_USDC_<CHAIN>          Override Circle's documented gas fee for a source chain
 *   CONFIG_BATCH_SIZE             Config entries per transaction (default: 100)
 *   SKIP_BUILDER                  Set to "1" to skip RelayAllocator.setPayloadBuilder
 *   SKIP_CONFIG                   Set to "1" to skip Config.setConfigValues
 *   DRY_RUN                       Set to "1" to print transaction to/data without broadcasting
 */

import { encodeAddress } from "@relay-protocol/settlement-sdk"
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  GATEWAY_CHAINS,
  type GatewayChainConfig,
  type GatewayChainName,
} from "../../configs/gateway-vm"

const allocatorAbi = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

const configAbi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
])

const gatewayPayloadBuilderAbi = parseAbi([
  "function getCircleDomainKey(string chainId) view returns (bytes32)",
  "function getGasFeeKey(string chainId) view returns (bytes32)",
  "function getDomainTokenKey(string chainId) view returns (bytes32)",
  "function getDestinationBuilderKey(string chainId) view returns (bytes32)",
  "function getDestinationDepositoryKey(string chainId) view returns (bytes32)",
  "function getAllocatorAllowedKey(address allocator) view returns (bytes32)",
])

type Env = {
  rpcUrl: string
  privateKey?: Hex
  allocator: Address
  config: Address
  payloadBuilder: Address
  destinationPayloadBuilder: Address
  depository: Address
  chainId: string
  sourceChain: GatewayChainName
  gatewayAllocators: Address[]
  configBatchSize: number
  skipBuilder: boolean
  skipConfig: boolean
  dryRun: boolean
}

type ConfigEntry = {
  label: string
  key: Hex
  value: Hex
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`set ${name}`)
  }
  return value
}

function optionalFlag(name: string): boolean {
  return process.env[name] === "1"
}

function asAddress(value: string, name: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address`)
  }
  return value as Address
}

function asHexBytes(value: string, name: string): Hex {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(
      `${name} must be 0x-prefixed hex bytes with an even number of hex chars`
    )
  }
  return value as Hex
}

function parseUint(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative decimal integer`)
  }
  return BigInt(value)
}

function parseAddressList(name: string, required: boolean): Address[] {
  const value = process.env[name]
  if (!value) {
    if (required) {
      throw new Error(`set ${name}`)
    }
    return []
  }

  const addresses = value
    .split(",")
    .map((entry) => asAddress(entry.trim(), name))
  const unique = new Map(
    addresses.map((address) => [address.toLowerCase(), address])
  )
  return [...unique.values()]
}

function parseSourceChain(): GatewayChainName {
  const supported = new Set(GATEWAY_CHAINS.map((chain) => chain.name))
  const sourceChain = requireEnv("SOURCE_CHAIN")
    .trim()
    .toLowerCase() as GatewayChainName
  if (!supported.has(sourceChain)) {
    throw new Error(
      `Unsupported SOURCE_CHAIN ${sourceChain}; expected one of ${[...supported].join(",")}`
    )
  }
  return sourceChain
}

function gatewayChainId(sourceChain: GatewayChainName): string {
  return `${sourceChain}-gateway`
}

function parseEnv(): Env {
  const dryRun = optionalFlag("DRY_RUN")
  const privateKey = process.env.PRIVATE_KEY
  if (!dryRun && !privateKey) {
    throw new Error("set PRIVATE_KEY or DRY_RUN=1")
  }
  if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string")
  }

  const configBatchSize = Number(
    parseUint("CONFIG_BATCH_SIZE", process.env.CONFIG_BATCH_SIZE ?? "100")
  )
  if (!Number.isSafeInteger(configBatchSize) || configBatchSize === 0) {
    throw new Error("CONFIG_BATCH_SIZE must be a positive safe integer")
  }

  const gatewayAllocators = parseAddressList("GATEWAY_ALLOCATORS", true)
  const sourceChain = parseSourceChain()

  return {
    rpcUrl: requireEnv("RPC_URL"),
    privateKey: privateKey as Hex | undefined,
    allocator: asAddress(requireEnv("ALLOCATOR"), "ALLOCATOR"),
    config: asAddress(requireEnv("CONFIG"), "CONFIG"),
    payloadBuilder: asAddress(requireEnv("PAYLOAD_BUILDER"), "PAYLOAD_BUILDER"),
    destinationPayloadBuilder: asAddress(
      requireEnv("DESTINATION_PAYLOAD_BUILDER"),
      "DESTINATION_PAYLOAD_BUILDER"
    ),
    depository: asAddress(requireEnv("DEPOSITORY"), "DEPOSITORY"),
    sourceChain,
    chainId: gatewayChainId(sourceChain),
    gatewayAllocators,
    configBatchSize,
    skipBuilder: optionalFlag("SKIP_BUILDER"),
    skipConfig: optionalFlag("SKIP_CONFIG"),
    dryRun,
  }
}

function uint256Word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex
}

function addressWord(value: Address): Hex {
  return `0x${value.slice(2).padStart(64, "0")}` as Hex
}

function gasFeeForChain(chain: GatewayChainConfig): bigint {
  const name = `GAS_FEE_USDC_${chain.envSuffix}`
  const value = process.env[name] ?? chain.gasFeeUsdc
  if (!/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new Error(`${name} must be a valid USDC amount`)
  }
  return parseUnits(value, 6)
}

async function sendOrPrintTx(args: {
  env: Env
  to: Address
  data: Hex
  publicClient: any
}) {
  if (args.env.dryRun) {
    console.log(`    to:   ${args.to}`)
    console.log(`    data: ${args.data}`)
    return
  }

  const account = privateKeyToAccount(args.env.privateKey!)
  const walletClient = createWalletClient({
    account,
    transport: http(args.env.rpcUrl),
  }) as any
  const hash = await walletClient.sendTransaction({
    to: args.to,
    data: args.data,
  })
  console.log(`    tx: ${hash}`)
  const receipt = await args.publicClient.waitForTransactionReceipt({ hash })
  console.log(`    status: ${receipt.status}`)
  if (receipt.status !== "success") {
    throw new Error(`transaction reverted: ${hash}`)
  }
}

async function readKey(args: {
  publicClient: any
  address: Address
  abi: typeof gatewayPayloadBuilderAbi
  functionName: string
  functionArgs?: readonly unknown[]
}): Promise<Hex> {
  return args.publicClient.readContract({
    address: args.address,
    abi: args.abi,
    functionName: args.functionName,
    args: args.functionArgs,
  })
}

async function buildConfigEntries(
  env: Env,
  publicClient: any
): Promise<ConfigEntry[]> {
  const entries: ConfigEntry[] = []
  const sourceChain = GATEWAY_CHAINS.find(
    (chain) => chain.name === env.sourceChain
  )
  if (!sourceChain) {
    throw new Error(`Unsupported source chain ${env.sourceChain}`)
  }
  const gatewayKey = (
    functionName: string,
    functionArgs?: readonly unknown[]
  ) =>
    readKey({
      publicClient,
      address: env.payloadBuilder,
      abi: gatewayPayloadBuilderAbi,
      functionName,
      functionArgs,
    })
  for (const chain of GATEWAY_CHAINS) {
    const [
      circleDomainKey,
      tokenKey,
      destinationBuilderKey,
      destinationDepositoryKey,
    ] = await Promise.all([
      gatewayKey("getCircleDomainKey", [chain.chainId]),
      gatewayKey("getDomainTokenKey", [chain.chainId]),
      gatewayKey("getDestinationBuilderKey", [chain.chainId]),
      gatewayKey("getDestinationDepositoryKey", [chain.chainId]),
    ])

    entries.push(
      {
        label: `${chain.name}.circleDomain`,
        key: circleDomainKey,
        value: uint256Word(BigInt(chain.domain)),
      },
      {
        label: `${chain.name}.token`,
        key: tokenKey,
        value: addressWord(chain.usdc),
      },
      {
        label: `${chain.name}.destinationBuilder`,
        key: destinationBuilderKey,
        value: addressWord(env.destinationPayloadBuilder),
      },
      {
        label: `${chain.name}.destinationDepository`,
        key: destinationDepositoryKey,
        value: addressWord(env.depository),
      }
    )
  }

  entries.push(
    {
      label: `${env.chainId}.circleDomain`,
      key: await gatewayKey("getCircleDomainKey", [env.chainId]),
      value: uint256Word(BigInt(sourceChain.domain)),
    },
    {
      label: `${env.chainId}.token`,
      key: await gatewayKey("getDomainTokenKey", [env.chainId]),
      value: addressWord(sourceChain.usdc),
    },
    {
      label: `${env.chainId}.gasFee`,
      key: await gatewayKey("getGasFeeKey", [env.chainId]),
      value: uint256Word(gasFeeForChain(sourceChain)),
    }
  )

  for (const allocator of env.gatewayAllocators) {
    entries.push({
      label: `allocator.${allocator}.allowed`,
      key: await gatewayKey("getAllocatorAllowedKey", [allocator]),
      value: uint256Word(1n),
    })
  }
  return entries
}

async function main() {
  const env = parseEnv()
  const publicClient = createPublicClient({
    transport: http(env.rpcUrl),
  }) as any
  const depository = asHexBytes(
    bytesToHex(encodeAddress(env.depository, "ethereum-vm")),
    "EVM-encoded Gateway depository"
  )

  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
  console.log("Configuring Gateway VM payload builder")
  console.log(`  chainId:                    ${env.chainId}`)
  console.log(`  depository:                 ${env.depository}`)
  console.log(`  depositoryEncoded:          ${depository}`)
  console.log(`  relayAllocator:             ${env.allocator}`)
  console.log(`  config:                     ${env.config}`)
  console.log(`  payloadBuilder:             ${env.payloadBuilder}`)
  console.log(`  destinationPayloadBuilder:  ${env.destinationPayloadBuilder}`)
  console.log(`  sourceChain:                ${env.sourceChain}`)
  console.log(
    `  gatewayAllocators:          ${env.gatewayAllocators.join(",")}`
  )
  console.log(`  dryRun:                     ${env.dryRun ? "1" : "0"}`)
  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )

  if (!env.skipBuilder) {
    console.log("==> Setting RelayAllocator payload builder")
    const data = encodeFunctionData({
      abi: allocatorAbi,
      functionName: "setPayloadBuilder",
      args: [env.chainId, depository, env.payloadBuilder],
    })
    await sendOrPrintTx({ env, to: env.allocator, data, publicClient })
  } else {
    console.log(
      "==> Skipping RelayAllocator.setPayloadBuilder (SKIP_BUILDER=1)"
    )
  }

  if (!env.skipConfig) {
    console.log("==> Resolving Gateway VM config keys")
    const entries = await buildConfigEntries(env, publicClient)
    for (const entry of entries) {
      console.log(`    ${entry.label} key=${entry.key} value=${entry.value}`)
    }

    for (let start = 0; start < entries.length; start += env.configBatchSize) {
      const batch = entries.slice(start, start + env.configBatchSize)
      console.log(
        `==> Sending Config.setConfigValues entries ${start + 1}-${start + batch.length} of ${entries.length}`
      )
      const data = encodeFunctionData({
        abi: configAbi,
        functionName: "setConfigValues",
        args: [
          batch.map((entry) => entry.key),
          batch.map((entry) => entry.value),
        ],
      })
      await sendOrPrintTx({ env, to: env.config, data, publicClient })
    }
  } else {
    console.log("==> Skipping Config.setConfigValues (SKIP_CONFIG=1)")
  }

  console.log("==> Done")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
