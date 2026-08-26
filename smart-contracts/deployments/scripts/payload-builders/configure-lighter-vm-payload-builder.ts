#!/usr/bin/env ts-node
/**
 * Configure LighterVmPayloadBuilder on the RelayAllocator and Config store.
 *
 * Actions:
 *   1. allocator.setPayloadBuilder(CHAIN_ID, SDK-encoded depository, PAYLOAD_BUILDER)
 *   2. Config.setConfigValues(...) for Lighter route types and asset indices:
 *      - 0x00000000000000000000000000000000 (USDC Perp) -> route type 0, asset index 3
 *      - 0x00000000000000000000000000000001 (ETH Spot)  -> route type 1, asset index 1
 *      - 0x00000000000000000000000000000003 (USDC Spot) -> route type 1, asset index 3
 *
 * Required env vars:
 *   RPC_URL                  RPC endpoint of the chain where Allocator/Config are deployed
 *   PRIVATE_KEY              allocator-owner key (not needed when DRY_RUN=1)
 *   ALLOCATOR                RelayAllocator contract address
 *   CONFIG                   Config contract address
 *   PAYLOAD_BUILDER          LighterVmPayloadBuilder contract address
 *   CHAIN_ID                 Relay chain id string
 *   DEPOSITORY               Lighter depository account index (SDK-encoded by this script)
 *
 * Optional env vars:
 *   SKIP_BUILDER             Set to "1" to skip allocator.setPayloadBuilder
 *   SKIP_CONFIG              Set to "1" to skip Config.setConfigValues
 *   DRY_RUN                  Set to "1" to print transaction to/data without broadcasting
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  bytesToHex,
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

const lighterPayloadBuilderAbi = parseAbi([
  "function getFromRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getToRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getAssetIndexKey(string chainId, bytes currency) view returns (bytes32)",
])

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

type CurrencyConfig = {
  currency: Hex
  label: string
  routeType: bigint
  assetIndex: bigint
}

const CURRENCY_CONFIGS: CurrencyConfig[] = [
  {
    currency: "0x00000000000000000000000000000000",
    label: "USDC Perp",
    routeType: 0n,
    assetIndex: 3n,
  },
  {
    currency: "0x00000000000000000000000000000001",
    label: "ETH Spot",
    routeType: 1n,
    assetIndex: 1n,
  },
  {
    currency: "0x00000000000000000000000000000003",
    label: "USDC Spot",
    routeType: 1n,
    assetIndex: 3n,
  },
]

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
    bytesToHex(encodeAddress(env.depository, "lighter-vm")),
    "SDK-encoded depository"
  )

  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
  console.log("Configuring Lighter VM payload builder")
  console.log(`  chainId:                 ${env.chainId}`)
  console.log(`  depository:              ${env.depository}`)
  console.log(`  depositoryEncoded:       ${depository}`)
  console.log(`  allocator:               ${env.allocator}`)
  console.log(`  config:                  ${env.config}`)
  console.log(`  payloadBuilder:          ${env.payloadBuilder}`)
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
    console.log("==> Resolving Lighter currency config keys")

    const keys: Hex[] = []
    const values: Hex[] = []

    for (const entry of CURRENCY_CONFIGS) {
      const [fromRouteKey, toRouteKey, assetIndexKey] = await Promise.all([
        publicClient.readContract({
          address: env.payloadBuilder,
          abi: lighterPayloadBuilderAbi,
          functionName: "getFromRouteTypeKey",
          args: [env.chainId, entry.currency],
        }),
        publicClient.readContract({
          address: env.payloadBuilder,
          abi: lighterPayloadBuilderAbi,
          functionName: "getToRouteTypeKey",
          args: [env.chainId, entry.currency],
        }),
        publicClient.readContract({
          address: env.payloadBuilder,
          abi: lighterPayloadBuilderAbi,
          functionName: "getAssetIndexKey",
          args: [env.chainId, entry.currency],
        }),
      ])

      const routeValue = uint256Word(entry.routeType)
      const assetValue = uint256Word(entry.assetIndex)

      keys.push(fromRouteKey, toRouteKey, assetIndexKey)
      values.push(routeValue, routeValue, assetValue)

      console.log(
        `    currency=${entry.currency} (${entry.label}) routeType=${entry.routeType} assetIndex=${entry.assetIndex}`
      )
      console.log(`      fromRouteType key=${fromRouteKey} value=${routeValue}`)
      console.log(`      toRouteType   key=${toRouteKey} value=${routeValue}`)
      console.log(
        `      assetIndex    key=${assetIndexKey} value=${assetValue}`
      )
    }

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
