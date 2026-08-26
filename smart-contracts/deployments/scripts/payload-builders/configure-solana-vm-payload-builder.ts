#!/usr/bin/env ts-node
/**
 * Configure SolanaVmPayloadBuilder on the RelayAllocator and Config store.
 *
 * Actions:
 *   1. allocator.setPayloadBuilder(CHAIN_ID, SDK-encoded depository, PAYLOAD_BUILDER)
 *   2. Config.setConfigValues(...) for:
 *      - Solana VM domain
 *      - Solana VM vault address
 *      - Solana VM request expiration delay, when EXPIRATION_SECONDS is set
 *
 * Required env vars:
 *   RPC_URL             RPC endpoint of the chain where Allocator/Config are deployed
 *   PRIVATE_KEY         allocator-owner key (not needed when DRY_RUN=1)
 *   ALLOCATOR           RelayAllocator contract address
 *   CONFIG              Config contract address
 *   PAYLOAD_BUILDER     SolanaVmPayloadBuilder contract address
 *   CHAIN_ID            Relay chain id string
 *   DEPOSITORY          Solana depository (program) address (SDK-encoded by this script)
 *
 * Optional env vars:
 *   SOLANA_RPC_URL      Solana RPC endpoint used to derive DOMAIN from the depository
 *                       (required for the Config step unless DOMAIN is provided)
 *   DOMAIN              Override the 32-byte Solana payload domain (otherwise derived
 *                       from the on-chain relay_depository account)
 *   VAULT_ADDRESS       Override the Solana vault address (otherwise derived as the
 *                       depository program's "vault" PDA); SDK-encoded by this script
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
import { Connection, PublicKey } from "@solana/web3.js"

const allocatorAbi = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

const configAbi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
])

const solanaPayloadBuilderAbi = parseAbi([
  "function getDomainKey(string chainId) view returns (bytes32)",
  "function getVaultAddressKey(string chainId) view returns (bytes32)",
  "function getExpirationKey() view returns (bytes32)",
])

// Seeds for the on-chain relay_depository program PDAs.
const RELAY_DEPOSITORY_SEED = Buffer.from("relay_depository")
const VAULT_SEED = Buffer.from("vault")

// Derive the Solana vault PDA (seed "vault") owned by the depository program.
function deriveVaultAddress(programId: string): string {
  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED],
    new PublicKey(programId)
  )
  return vault.toBase58()
}

// Read the domain separator stored in the on-chain relay_depository account.
// Account layout: discriminator(8) + owner(32) + allocator(32) + vault_bump(1)
//   + Option<[u8; 32]> domain_separator (1-byte flag + 32 bytes when present).
async function readDomainSeparator(
  rpcUrl: string,
  programId: string
): Promise<Hex> {
  const connection = new Connection(rpcUrl, "confirmed")
  const program = new PublicKey(programId)
  const [pda] = PublicKey.findProgramAddressSync(
    [RELAY_DEPOSITORY_SEED],
    program
  )
  const info = await connection.getAccountInfo(pda)
  if (!info) {
    throw new Error(
      `relay_depository account not found at ${pda.toBase58()} — is ${programId} initialized?`
    )
  }
  const flagOffset = 8 + 32 + 32 + 1
  if (info.data[flagOffset] !== 1) {
    throw new Error(
      "relay_depository has no domain_separator set (run migrate_domain_separator, or pass DOMAIN explicitly)"
    )
  }
  const separator = info.data.subarray(flagOffset + 1, flagOffset + 1 + 32)
  return bytesToHex(new Uint8Array(separator))
}

type Env = {
  rpcUrl: string
  privateKey?: Hex
  allocator: Address
  config: Address
  payloadBuilder: Address
  chainId: string
  depository: string
  solanaRpcUrl?: string
  domainOverride?: Hex
  vaultAddressOverride?: string
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

function asBytes32(value: string, name: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hex value`)
  }
  return value as Hex
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
    allocator: asAddress(requireEnv("ALLOCATOR"), "ALLOCATOR"),
    chainId: requireEnv("CHAIN_ID"),
    config: asAddress(requireEnv("CONFIG"), "CONFIG"),
    depository: requireEnv("DEPOSITORY"),
    domainOverride: process.env.DOMAIN
      ? asBytes32(process.env.DOMAIN, "DOMAIN")
      : undefined,
    dryRun,
    expirationSeconds: parseOptionalUintEnv("EXPIRATION_SECONDS"),
    payloadBuilder: asAddress(requireEnv("PAYLOAD_BUILDER"), "PAYLOAD_BUILDER"),
    privateKey: privateKey as Hex | undefined,
    rpcUrl: requireEnv("RPC_URL"),
    skipBuilder: optionalFlag("SKIP_BUILDER"),
    skipConfig: optionalFlag("SKIP_CONFIG"),
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
    vaultAddressOverride: process.env.VAULT_ADDRESS,
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
    bytesToHex(encodeAddress(env.depository, "solana-vm")),
    "SDK-encoded depository"
  )

  // Domain and vault address are derived from the depository program unless
  // explicitly overridden. They are only needed for the Config step.
  let domain: Hex | undefined
  let vaultAddressBase58: string | undefined
  let vaultAddress: Hex | undefined
  if (!env.skipConfig) {
    vaultAddressBase58 =
      env.vaultAddressOverride ?? deriveVaultAddress(env.depository)
    vaultAddress = asBytes32(
      bytesToHex(encodeAddress(vaultAddressBase58, "solana-vm")),
      "SDK-encoded vault address"
    )

    if (env.domainOverride) {
      domain = env.domainOverride
    } else {
      if (!env.solanaRpcUrl) {
        throw new Error(
          "set SOLANA_RPC_URL to derive DOMAIN from the depository (or pass DOMAIN explicitly)"
        )
      }
      domain = asBytes32(
        await readDomainSeparator(env.solanaRpcUrl, env.depository),
        "derived domain"
      )
    }
  }

  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
  console.log("Configuring Solana VM payload builder")
  console.log(`  chainId:            ${env.chainId}`)
  console.log(`  depository:         ${env.depository}`)
  console.log(`  depositoryEncoded:  ${depository}`)
  console.log(`  allocator:          ${env.allocator}`)
  console.log(`  config:             ${env.config}`)
  console.log(`  payloadBuilder:     ${env.payloadBuilder}`)
  console.log(
    `  domain:             ${domain ?? "n/a (config skipped)"}${
      domain && !env.domainOverride ? " (derived)" : ""
    }`
  )
  console.log(
    `  vaultAddress:       ${vaultAddressBase58 ?? "n/a (config skipped)"}${
      vaultAddressBase58 && !env.vaultAddressOverride ? " (derived)" : ""
    }`
  )
  console.log(`  vaultEncoded:       ${vaultAddress ?? "n/a (config skipped)"}`)
  console.log(`  expirationSeconds:  ${env.expirationSeconds ?? "unchanged"}`)
  console.log(`  dryRun:             ${env.dryRun ? "1" : "0"}`)
  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )

  if (!env.skipBuilder) {
    console.log("==> Setting allocator payload builder")
    const data = encodeFunctionData({
      abi: allocatorAbi,
      args: [env.chainId, depository, env.payloadBuilder],
      functionName: "setPayloadBuilder",
    })
    await sendOrPrintTx({ data, env, publicClient, to: env.allocator })
  } else {
    console.log("==> Skipping allocator.setPayloadBuilder (SKIP_BUILDER=1)")
  }

  if (!env.skipConfig) {
    console.log("==> Resolving Solana VM config keys")

    const keys: Hex[] = []
    const values: Hex[] = []

    const [domainKey, vaultAddressKey] = await Promise.all([
      publicClient.readContract({
        abi: solanaPayloadBuilderAbi,
        address: env.payloadBuilder,
        args: [env.chainId],
        functionName: "getDomainKey",
      }),
      publicClient.readContract({
        abi: solanaPayloadBuilderAbi,
        address: env.payloadBuilder,
        args: [env.chainId],
        functionName: "getVaultAddressKey",
      }),
    ])

    keys.push(domainKey, vaultAddressKey)
    values.push(domain!, vaultAddress!)

    console.log(`    domain       key=${domainKey} value=${domain}`)
    console.log(`    vaultAddress key=${vaultAddressKey} value=${vaultAddress}`)

    if (env.expirationSeconds !== undefined) {
      const expirationKey = await publicClient.readContract({
        abi: solanaPayloadBuilderAbi,
        address: env.payloadBuilder,
        functionName: "getExpirationKey",
      })
      const expirationValue = uint256Word(env.expirationSeconds)
      keys.push(expirationKey)
      values.push(expirationValue)
      console.log(
        `    expiration   key=${expirationKey} value=${expirationValue}`
      )
    } else {
      console.log("    expiration   unchanged (EXPIRATION_SECONDS not set)")
    }

    console.log(`==> Sending Config.setConfigValues to ${env.config}`)
    const data = encodeFunctionData({
      abi: configAbi,
      args: [keys, values],
      functionName: "setConfigValues",
    })
    await sendOrPrintTx({ data, env, publicClient, to: env.config })
  } else {
    console.log("==> Skipping Config.setConfigValues (SKIP_CONFIG=1)")
  }

  console.log("==> Done")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
