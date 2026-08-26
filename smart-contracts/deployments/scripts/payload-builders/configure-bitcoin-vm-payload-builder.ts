#!/usr/bin/env ts-node
/**
 * Configure BitcoinVmPayloadBuilder on the RelayAllocator.
 *
 * Actions:
 *   1. allocator.setPayloadBuilder(CHAIN_ID, SDK-encoded depository, PAYLOAD_BUILDER)
 *
 * Required env vars:
 *   RPC_URL          RPC endpoint of the chain where Allocator is deployed
 *   PRIVATE_KEY      allocator-owner key (not needed when DRY_RUN=1)
 *   ALLOCATOR        RelayAllocator contract address
 *   PAYLOAD_BUILDER  BitcoinVmPayloadBuilder contract address
 *   CHAIN_ID         Relay chain id string
 *   DEPOSITORY       Bitcoin depository address (SDK-encoded by this script)
 *
 * Optional env vars:
 *   SKIP_BUILDER     Set to "1" to skip allocator.setPayloadBuilder
 *   DRY_RUN          Set to "1" to print transaction to/data without broadcasting
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

type Env = {
  rpcUrl: string
  privateKey?: Hex
  allocator: Address
  payloadBuilder: Address
  chainId: string
  depository: string
  skipBuilder: boolean
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
    payloadBuilder: asAddress(requireEnv("PAYLOAD_BUILDER"), "PAYLOAD_BUILDER"),
    chainId: requireEnv("CHAIN_ID"),
    depository: requireEnv("DEPOSITORY"),
    skipBuilder: optionalFlag("SKIP_BUILDER"),
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
    bytesToHex(encodeAddress(env.depository, "bitcoin-vm")),
    "SDK-encoded depository"
  )

  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
  console.log("Configuring Bitcoin VM payload builder")
  console.log(`  chainId:            ${env.chainId}`)
  console.log(`  depository:         ${env.depository}`)
  console.log(`  depositoryEncoded:  ${depository}`)
  console.log(`  allocator:          ${env.allocator}`)
  console.log(`  payloadBuilder:     ${env.payloadBuilder}`)
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

  console.log("==> Done")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
