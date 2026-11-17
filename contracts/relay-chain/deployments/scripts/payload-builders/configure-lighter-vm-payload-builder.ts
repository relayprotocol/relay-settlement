#!/usr/bin/env ts-node
/**
 * Configure LighterVmPayloadBuilder on the RelayAllocator and Config store.
 *
 * Actions, in this order (the builder is registered only once it can build):
 *   1. Config.setConfigValues(...) for the selected Lighter deployment
 *      (see lighter-vm-currency-sets.ts):
 *      - the depository account index (DEPOSITORY) and Lighter app-chain id
 *        (LIGHTER_CHAIN_ID) signed into every transfer
 *      - the route types and asset indices of its currency set:
 *        - lighter:           USDC Perp (route 0, asset 3), ETH Spot (route 1, asset 1),
 *                             USDC Spot (route 1, asset 3)
 *        - robinhood-lighter: USDG Perp (route 0, asset 3)
 *   2. allocator.setPayloadBuilder(CHAIN_ID, SDK-encoded depository, PAYLOAD_BUILDER)
 *
 * One generic LighterVmPayloadBuilder serves every Lighter deployment; each has
 * its own Relay chain id and Config values, so run this once per deployment with
 * the shared PAYLOAD_BUILDER and that deployment's CHAIN_ID and DEPOSITORY.
 *
 * Every Config key is read back first, and a key already set is authoritative:
 * it is never rewritten to the currency-set default (drift is logged as
 * [keep]), so re-running the script is a no-op for a configured deployment and
 * values carried over from a previous builder survive later runs. To change a
 * set value on purpose, write it directly or disable the currency and re-enable
 * it through REENABLE_CURRENCIES. A
 * zero asset index disables a currency (the builder reverts CurrencyDisabled),
 * so an on-chain zero is never overwritten with the currency set's default
 * unless its label is listed in REENABLE_CURRENCIES. When PAYLOAD_BUILDER
 * replaces a builder with another key derivation, pass PREVIOUS_PAYLOAD_BUILDER:
 * a currency whose new keys are unset is migrated, not seeded: its route types
 * and asset index are read under the previous builder's keys and carried over
 * as they are ([migrate] line when they differ from the currency set); an unset
 * legacy route type takes the set default, and a zero or unset legacy asset
 * index is written as an explicit 0 under the new key ([disabled] warning), so
 * later re-runs are safe without any env. A currency
 * whose asset-index key is unset while its route-type keys are set is refused
 * without PREVIOUS_PAYLOAD_BUILDER or REENABLE_CURRENCIES. A
 * PREVIOUS_PAYLOAD_BUILDER equal to PAYLOAD_BUILDER, or one under which no
 * currency has a non-zero asset index, is refused as a wrong address unless
 * CONFIRM_DISABLE_ALL=1 confirms disabling every currency on purpose. Without a
 * previous builder the script refuses a builder whose currency keys are all
 * unset unless MIGRATION_REVIEWED=1 confirms a first-time configuration; the
 * two flags are distinct on purpose (see lighter-vm-config-plan.ts).
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
 *   CURRENCY_SET             Lighter deployment whose currency set to write
 *                            (`lighter` or `robinhood-lighter`); defaults to CHAIN_ID
 *   LIGHTER_CHAIN_ID         Lighter app-chain id to sign transfers with; defaults
 *                            to the known app-chain id of CHAIN_ID
 *   SKIP_BUILDER             Set to "1" to skip allocator.setPayloadBuilder
 *   SKIP_CONFIG              Set to "1" to skip Config.setConfigValues
 *   REENABLE_CURRENCIES      Comma-separated labels of disabled currencies whose
 *                            asset index may be written, exactly as in the
 *                            currency set (e.g. "ETH Spot,USDC Spot"); an
 *                            unknown label is an error
 *   PREVIOUS_PAYLOAD_BUILDER Builder being replaced; currencies whose keys are
 *                            unset under PAYLOAD_BUILDER are checked under its keys
 *   MIGRATION_REVIEWED       Set to "1" to configure a builder whose currency keys
 *                            are all unset without PREVIOUS_PAYLOAD_BUILDER
 *                            (first-time configuration only)
 *   CONFIRM_DISABLE_ALL      Set to "1" to accept a PREVIOUS_PAYLOAD_BUILDER under
 *                            which no currency is enabled, writing asset index
 *                            0 for every currency
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

import {
  getLighterAppChainId,
  getLighterCurrencySet,
} from "./lighter-vm-currency-sets"
import type { LighterCurrencyConfig } from "./lighter-vm-currency-sets"
import {
  lighterConfigAbi,
  parseReenableCurrencies,
  planLighterConfigWrites,
} from "./lighter-vm-config-plan"

const allocatorAbi = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

type Env = {
  rpcUrl: string
  privateKey?: Hex
  allocator: Address
  config: Address
  payloadBuilder: Address
  chainId: string
  depository: string
  lighterChainId: bigint
  currencySet: string
  currencies: LighterCurrencyConfig[]
  previousPayloadBuilder?: Address
  skipBuilder: boolean
  skipConfig: boolean
  reenableCurrencies: string[]
  migrationReviewed: boolean
  confirmDisableAll: boolean
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

function asUint64(value: string, name: string): bigint {
  if (!/^[0-9]+$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    throw new Error(`${name} must be a decimal uint64`)
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

  const chainId = requireEnv("CHAIN_ID")
  const currencySet = process.env.CURRENCY_SET || chainId

  return {
    rpcUrl: requireEnv("RPC_URL"),
    privateKey: privateKey as Hex | undefined,
    allocator: asAddress(requireEnv("ALLOCATOR"), "ALLOCATOR"),
    config: asAddress(requireEnv("CONFIG"), "CONFIG"),
    payloadBuilder: asAddress(requireEnv("PAYLOAD_BUILDER"), "PAYLOAD_BUILDER"),
    chainId,
    depository: requireEnv("DEPOSITORY"),
    lighterChainId: process.env.LIGHTER_CHAIN_ID
      ? asUint64(process.env.LIGHTER_CHAIN_ID, "LIGHTER_CHAIN_ID")
      : getLighterAppChainId(chainId),
    currencySet,
    currencies: getLighterCurrencySet(currencySet),
    previousPayloadBuilder: process.env.PREVIOUS_PAYLOAD_BUILDER
      ? asAddress(
          process.env.PREVIOUS_PAYLOAD_BUILDER,
          "PREVIOUS_PAYLOAD_BUILDER"
        )
      : undefined,
    skipBuilder: optionalFlag("SKIP_BUILDER"),
    skipConfig: optionalFlag("SKIP_CONFIG"),
    reenableCurrencies: parseReenableCurrencies(
      process.env.REENABLE_CURRENCIES
    ),
    migrationReviewed: optionalFlag("MIGRATION_REVIEWED"),
    confirmDisableAll: optionalFlag("CONFIRM_DISABLE_ALL"),
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
  // Stop on a revert: the builder must not be registered when the Config write
  // that it depends on failed.
  if (receipt.status !== "success") {
    throw new Error(`transaction ${hash} to ${args.to} reverted`)
  }
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
  console.log(
    `  previousPayloadBuilder:  ${env.previousPayloadBuilder ?? "(none)"}`
  )
  console.log(`  lighterChainId:          ${env.lighterChainId}`)
  console.log(`  currencySet:             ${env.currencySet}`)
  console.log(`  dryRun:                  ${env.dryRun ? "1" : "0"}`)
  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )

  if (!env.skipConfig) {
    const { keys, values } = await planLighterConfigWrites({
      chainId: env.chainId,
      client: publicClient,
      config: env.config,
      currencies: env.currencies,
      instance: {
        fromAccountIndex: asUint64(env.depository, "DEPOSITORY"),
        lighterChainId: env.lighterChainId,
      },
      confirmDisableAll: env.confirmDisableAll,
      migrationReviewed: env.migrationReviewed,
      payloadBuilder: env.payloadBuilder,
      previousPayloadBuilder: env.previousPayloadBuilder,
      reenableCurrencies: env.reenableCurrencies,
    })

    if (keys.length === 0) {
      console.log("==> Config already up to date, skipping setConfigValues")
    } else {
      console.log(`==> Sending Config.setConfigValues to ${env.config}`)
      const data = encodeFunctionData({
        abi: lighterConfigAbi,
        functionName: "setConfigValues",
        args: [keys, values],
      })
      await sendOrPrintTx({ env, to: env.config, data, publicClient })
    }
  } else {
    console.log("==> Skipping Config.setConfigValues (SKIP_CONFIG=1)")
  }

  // Register the builder only after its Config values are written: a
  // config-driven builder cannot build until both instance keys are set, so the
  // reverse order would fail every withdrawal on an already-live chain.
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

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
