#!/usr/bin/env ts-node
/**
 * Configure HyperliquidVmPayloadBuilder on the RelayAllocator and Config store.
 *
 * Actions:
 *   1. allocator.setPayloadBuilder(CHAIN_ID, SDK-encoded depository, PAYLOAD_BUILDER)
 *   2. Config.setConfigValues(...) for hardcoded Hyperliquid currency metadata:
 *      - 0x2e6d84f2d7ca82e6581e03523e4389f7 (USDE spot) -> symbol USDE, 2 decimals, spot -> spot
 *      - 0x6d1e7cde53ba9467b783cb7c530ce054 (USDC spot) -> symbol USDC, 8 decimals, spot -> spot
 *      - 0x00000000000000000000000000000000 (USDC perp) -> 8 decimals
 *
 * Required env vars:
 *   RPC_URL          RPC endpoint of the chain where Allocator/Config are deployed
 *   PRIVATE_KEY      allocator-owner key (not needed when DRY_RUN=1)
 *   ALLOCATOR        RelayAllocator contract address
 *   CONFIG           Config contract address
 *   PAYLOAD_BUILDER  HyperliquidVmPayloadBuilder contract address
 *   CHAIN_ID         Relay chain id string
 *   DEPOSITORY       Hyperliquid depository address (SDK-encoded by this script)
 *
 * Optional env vars:
 *   SKIP_BUILDER             Set to "1" to skip allocator.setPayloadBuilder
 *   SKIP_CONFIG              Set to "1" to skip Config.setConfigValues
 *   DRY_RUN                  Set to "1" to print transaction to/data without broadcasting
 */

import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { encodeAddress } from "@relay-protocol/settlement-sdk"

const allocatorAbi = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

const configAbi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
])

const hyperliquidPayloadBuilderAbi = parseAbi([
  "function getTargetDecimalsKey(string chainId, bytes currency) view returns (bytes32)",
  "function getCurrencySymbolKey(string chainId, bytes currency) view returns (bytes32)",
  "function getSourceDexKey(string chainId, bytes currency) view returns (bytes32)",
  "function getDestinationDexKey(string chainId, bytes currency) view returns (bytes32)",
])

const PERPS_USDC_CURRENCY = "0x00000000000000000000000000000000" as Hex
const PERPS_USDC_TARGET_DECIMALS = 8n

const USDE_CURRENCY = "0x2e6d84f2d7ca82e6581e03523e4389f7" as Hex
const USDE_SYMBOL = "USDE"
const USDE_TARGET_DECIMALS = 2n
const USDE_SOURCE_DEX = "spot"
const USDE_DESTINATION_DEX = "spot"

const SPOT_USDC_CURRENCY = "0x6d1e7cde53ba9467b783cb7c530ce054" as Hex
const SPOT_USDC_SYMBOL = "USDC"
const SPOT_USDC_TARGET_DECIMALS = 8n
const SPOT_USDC_SOURCE_DEX = "spot"
const SPOT_USDC_DESTINATION_DEX = "spot"

type SpotCurrencyConfig = {
  currency: Hex
  label: string
  symbol: string
  targetDecimals: bigint
  sourceDex: string
  destinationDex: string
}

const SPOT_CURRENCY_CONFIGS: SpotCurrencyConfig[] = [
  {
    currency: USDE_CURRENCY,
    label: "USDE spot",
    symbol: USDE_SYMBOL,
    targetDecimals: USDE_TARGET_DECIMALS,
    sourceDex: USDE_SOURCE_DEX,
    destinationDex: USDE_DESTINATION_DEX,
  },
  {
    currency: SPOT_USDC_CURRENCY,
    label: "USDC spot",
    symbol: SPOT_USDC_SYMBOL,
    targetDecimals: SPOT_USDC_TARGET_DECIMALS,
    sourceDex: SPOT_USDC_SOURCE_DEX,
    destinationDex: SPOT_USDC_DESTINATION_DEX,
  },
]

type Env = {
  rpcUrl: string
  privateKey?: Hex
  allocator: Address
  config: Address
  payloadBuilder: Address
  chainId: string
  depository: string
  skipBuilder: boolean
  skipConfig: boolean
  dryRun: boolean
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

function uint256Word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex
}

function bytes32String(value: string, name: string): Hex {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length > 32) {
    throw new Error(`${name} must be at most 32 bytes`)
  }
  return `0x${bytes.toString("hex").padEnd(64, "0")}` as Hex
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

  return {
    rpcUrl: requireEnv("RPC_URL"),
    privateKey: privateKey as Hex | undefined,
    allocator: asAddress(requireEnv("ALLOCATOR"), "ALLOCATOR"),
    config: asAddress(requireEnv("CONFIG"), "CONFIG"),
    payloadBuilder: asAddress(requireEnv("PAYLOAD_BUILDER"), "PAYLOAD_BUILDER"),
    chainId: requireEnv("CHAIN_ID"),
    depository: requireEnv("DEPOSITORY"),
    skipBuilder: optionalFlag("SKIP_BUILDER"),
    skipConfig: optionalFlag("SKIP_CONFIG"),
    dryRun,
  }
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
}

async function main() {
  const env = parseEnv()
  const publicClient = createPublicClient({
    transport: http(env.rpcUrl),
  }) as any
  const depository = asHexBytes(
    bytesToHex(encodeAddress(env.depository, "hyperliquid-vm")),
    "SDK-encoded depository"
  )

  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
  console.log("Configuring Hyperliquid VM payload builder")
  console.log(`  chainId:                 ${env.chainId}`)
  console.log(`  depository:              ${env.depository}`)
  console.log(`  depositoryEncoded:       ${depository}`)
  console.log(`  allocator:               ${env.allocator}`)
  console.log(`  config:                  ${env.config}`)
  console.log(`  payloadBuilder:          ${env.payloadBuilder}`)
  console.log(`  usdeCurrency:            ${USDE_CURRENCY}`)
  console.log(`  spotUsdcCurrency:        ${SPOT_USDC_CURRENCY}`)
  console.log(`  perpsUsdcCurrency:       ${PERPS_USDC_CURRENCY}`)
  console.log(`  dryRun:                  ${env.dryRun ? "1" : "0"}`)
  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )

  if (!env.skipBuilder) {
    console.log("==> Setting allocator payload builder")
    const data = encodeFunctionData({
      abi: allocatorAbi,
      functionName: "setPayloadBuilder",
      args: [env.chainId, depository, env.payloadBuilder],
    })
    await sendOrPrintTx({ env, to: env.allocator, data, publicClient })
  } else {
    console.log("==> Skipping allocator.setPayloadBuilder (SKIP_BUILDER=1)")
  }

  if (!env.skipConfig) {
    console.log("==> Resolving Hyperliquid currency config keys")

    const keys: Hex[] = []
    const values: Hex[] = []

    for (const entry of SPOT_CURRENCY_CONFIGS) {
      const [symbolKey, decimalsKey, sourceDexKey, destinationDexKey] =
        await Promise.all([
          publicClient.readContract({
            address: env.payloadBuilder,
            abi: hyperliquidPayloadBuilderAbi,
            functionName: "getCurrencySymbolKey",
            args: [env.chainId, entry.currency],
          }),
          publicClient.readContract({
            address: env.payloadBuilder,
            abi: hyperliquidPayloadBuilderAbi,
            functionName: "getTargetDecimalsKey",
            args: [env.chainId, entry.currency],
          }),
          publicClient.readContract({
            address: env.payloadBuilder,
            abi: hyperliquidPayloadBuilderAbi,
            functionName: "getSourceDexKey",
            args: [env.chainId, entry.currency],
          }),
          publicClient.readContract({
            address: env.payloadBuilder,
            abi: hyperliquidPayloadBuilderAbi,
            functionName: "getDestinationDexKey",
            args: [env.chainId, entry.currency],
          }),
        ])

      const symbolValue = bytes32String(entry.symbol, `${entry.label} symbol`)
      const decimalsValue = uint256Word(entry.targetDecimals)
      const sourceDexValue = bytes32String(
        entry.sourceDex,
        `${entry.label} source dex`
      )
      const destinationDexValue = bytes32String(
        entry.destinationDex,
        `${entry.label} destination dex`
      )

      keys.push(symbolKey, decimalsKey, sourceDexKey, destinationDexKey)
      values.push(
        symbolValue,
        decimalsValue,
        sourceDexValue,
        destinationDexValue
      )

      console.log(
        `    currency=${entry.currency} (${entry.label}) symbol=${entry.symbol}`
      )
      console.log(`      symbol         key=${symbolKey} value=${symbolValue}`)
      console.log(
        `      targetDecimals key=${decimalsKey} value=${decimalsValue}`
      )
      console.log(
        `      sourceDex      key=${sourceDexKey} value=${sourceDexValue}`
      )
      console.log(
        `      destinationDex key=${destinationDexKey} value=${destinationDexValue}`
      )
    }

    const perpsUsdcDecimalsKey = await publicClient.readContract({
      address: env.payloadBuilder,
      abi: hyperliquidPayloadBuilderAbi,
      functionName: "getTargetDecimalsKey",
      args: [env.chainId, PERPS_USDC_CURRENCY],
    })
    const perpsUsdcDecimalsValue = uint256Word(PERPS_USDC_TARGET_DECIMALS)
    keys.push(perpsUsdcDecimalsKey)
    values.push(perpsUsdcDecimalsValue)

    console.log(
      `    perpsUsdcCurrency=${PERPS_USDC_CURRENCY} targetDecimals=${PERPS_USDC_TARGET_DECIMALS}`
    )
    console.log(
      `      targetDecimals key=${perpsUsdcDecimalsKey} value=${perpsUsdcDecimalsValue}`
    )

    console.log(`==> Sending Config.setConfigValues to ${env.config}`)
    const data = encodeFunctionData({
      abi: configAbi,
      functionName: "setConfigValues",
      args: [keys, values],
    })
    await sendOrPrintTx({ env, to: env.config, data, publicClient })
  } else {
    console.log("==> Skipping Config.setConfigValues (SKIP_CONFIG=1)")
  }

  console.log("==> Done")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
