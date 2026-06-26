#!/usr/bin/env ts-node
/**
 * Configure EthereumVmPayloadBuilder on the RelayAllocator and Config store.
 *
 * Actions:
 *   1. allocator.setPayloadBuilder(CHAIN_ID, SDK-encoded depository, PAYLOAD_BUILDER)
 *   2. Config.setConfigValues(...) for:
 *      - Ethereum VM EIP-712 signature chain id
 *      - Ethereum VM request expiration delay, when EXPIRATION_SECONDS is set
 *
 * Required env vars:
 *   RPC_URL             RPC endpoint of the chain where Allocator/Config are deployed
 *   PRIVATE_KEY         allocator-owner key (not needed when DRY_RUN=1)
 *   ALLOCATOR           RelayAllocator contract address
 *   CONFIG              Config contract address
 *   PAYLOAD_BUILDER     EthereumVmPayloadBuilder contract address
 *   CHAIN_ID            Relay chain id string
 *   DEPOSITORY          Ethereum depository address (SDK-encoded by this script)
 *   SIGNATURE_CHAIN_ID  EIP-712 domain chain id for this Ethereum VM chain
 *
 * Optional env vars:
 *   EXPIRATION_SECONDS  Set request expiration delay in seconds
 *   SKIP_BUILDER        Set to "1" to skip allocator.setPayloadBuilder
 *   SKIP_CONFIG         Set to "1" to skip Config.setConfigValues
 *   DRY_RUN             Set to "1" to print transaction to/data without broadcasting
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

const ethereumPayloadBuilderAbi = parseAbi([
  "function getEvmChainIdKey(string chainId) view returns (bytes32)",
  "function getExpirationKey() view returns (bytes32)",
])

type Env = {
  rpcUrl: string
  privateKey?: Hex
  allocator: Address
  config: Address
  payloadBuilder: Address
  chainId: string
  depository: string
  signatureChainId: bigint
  expirationSeconds?: bigint
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

function parseUintEnv(name: string): bigint {
  return parseUint(name, requireEnv(name))
}

function parseOptionalUintEnv(name: string): bigint | undefined {
  const value = process.env[name]
  return value === undefined ? undefined : parseUint(name, value)
}

function parseUint(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative decimal integer`)
  }
  return BigInt(value)
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
    signatureChainId: parseUintEnv("SIGNATURE_CHAIN_ID"),
    expirationSeconds: parseOptionalUintEnv("EXPIRATION_SECONDS"),
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
    bytesToHex(encodeAddress(env.depository, "ethereum-vm")),
    "SDK-encoded depository"
  )

  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
  console.log("Configuring Ethereum VM payload builder")
  console.log(`  chainId:            ${env.chainId}`)
  console.log(`  depository:         ${env.depository}`)
  console.log(`  depositoryEncoded:  ${depository}`)
  console.log(`  allocator:          ${env.allocator}`)
  console.log(`  config:             ${env.config}`)
  console.log(`  payloadBuilder:     ${env.payloadBuilder}`)
  console.log(`  signatureChainId:   ${env.signatureChainId}`)
  console.log(`  expirationSeconds:  ${env.expirationSeconds ?? "unchanged"}`)
  console.log(`  dryRun:             ${env.dryRun ? "1" : "0"}`)
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
    console.log("==> Resolving Ethereum VM config keys")

    const keys: Hex[] = []
    const values: Hex[] = []

    const chainIdKey = await publicClient.readContract({
      address: env.payloadBuilder,
      abi: ethereumPayloadBuilderAbi,
      functionName: "getEvmChainIdKey",
      args: [env.chainId],
    })
    const chainIdValue = uint256Word(env.signatureChainId)
    keys.push(chainIdKey)
    values.push(chainIdValue)
    console.log(`    signatureChainId key=${chainIdKey} value=${chainIdValue}`)

    if (env.expirationSeconds !== undefined) {
      const expirationKey = await publicClient.readContract({
        address: env.payloadBuilder,
        abi: ethereumPayloadBuilderAbi,
        functionName: "getExpirationKey",
      })
      const expirationValue = uint256Word(env.expirationSeconds)
      keys.push(expirationKey)
      values.push(expirationValue)
      console.log(
        `    expiration       key=${expirationKey} value=${expirationValue}`
      )
    } else {
      console.log("    expiration       unchanged (EXPIRATION_SECONDS not set)")
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
