#!/usr/bin/env ts-node
/**
 * Configure XrpVmPayloadBuilder on the RelayAllocator.
 *
 * The XRP builder has no Config-store dependencies — it is fully configured by
 * its constructor immutable (the signing public key) and the per-request data
 * the solver supplies — so this script only registers the builder with the
 * allocator for the (chainId, depository) pair.
 *
 * Action:
 *   allocator.setPayloadBuilder(CHAIN_ID, SDK-encoded depository, PAYLOAD_BUILDER)
 *
 * Required env vars:
 *   RPC_URL          RPC endpoint of the chain where the Allocator is deployed
 *   PRIVATE_KEY      allocator-owner key (not needed when DRY_RUN=1)
 *   ALLOCATOR        RelayAllocator contract address
 *   PAYLOAD_BUILDER  XrpVmPayloadBuilder contract address
 *   CHAIN_ID         Relay chain id string
 *   DEPOSITORY       XRP depository classic ("r...") address (SDK-encoded here)
 *
 * Optional env vars:
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
    allocator: asAddress(requireEnv("ALLOCATOR"), "ALLOCATOR"),
    chainId: requireEnv("CHAIN_ID"),
    depository: requireEnv("DEPOSITORY"),
    dryRun,
    payloadBuilder: asAddress(requireEnv("PAYLOAD_BUILDER"), "PAYLOAD_BUILDER"),
    privateKey: privateKey as Hex | undefined,
    rpcUrl: requireEnv("RPC_URL"),
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
    data: args.data,
    to: args.to,
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
    bytesToHex(encodeAddress(env.depository, "xrp-vm")),
    "SDK-encoded depository"
  )

  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
  console.log("Configuring XRP VM payload builder")
  console.log(`  chainId:            ${env.chainId}`)
  console.log(`  depository:         ${env.depository}`)
  console.log(`  depositoryEncoded:  ${depository}`)
  console.log(`  allocator:          ${env.allocator}`)
  console.log(`  payloadBuilder:     ${env.payloadBuilder}`)
  console.log(`  dryRun:             ${env.dryRun ? "1" : "0"}`)
  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )

  console.log("==> Setting allocator payload builder")
  const data = encodeFunctionData({
    abi: allocatorAbi,
    args: [env.chainId, depository, env.payloadBuilder],
    functionName: "setPayloadBuilder",
  })
  await sendOrPrintTx({ data, env, publicClient, to: env.allocator })

  console.log("==> Done")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
