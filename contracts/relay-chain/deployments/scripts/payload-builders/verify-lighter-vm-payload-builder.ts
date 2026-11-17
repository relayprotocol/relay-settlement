#!/usr/bin/env ts-node
/**
 * Read-only check of a deployed LighterVmPayloadBuilder and its wiring.
 *
 * Confirms, against the hub chain:
 *   1. Builder wiring and instance config: CONFIG is the expected Config store,
 *      and the Config values behind getFromAccountIndex(CHAIN_ID) and
 *      getLighterChainId(CHAIN_ID) are the depository account index and the
 *      Lighter app-chain id (304 for Lighter mainnet, 466324 for Robinhood
 *      Lighter).
 *   2. Allocator registration: payloadBuilders(CHAIN_ID, encoded depository)
 *      returns the builder.
 *   3. Config store: the route type and asset index of every currency in the
 *      deployment's currency set (see lighter-vm-currency-sets.ts) is set to
 *      the expected value.
 *   4. A sample `buildPayload` call decodes to a Transfer whose
 *      fromAccountIndex, lighterChainId, route types and asset index match.
 *
 * A zero asset index disables a currency (the configure script persists zero
 * for a held-back currency). The run must be told which currencies are meant
 * to be disabled: a zero for a currency listed in EXPECT_DISABLED is reported
 * as an informational `[disabled] <label>` line, steps 3 and 4 are skipped for
 * it, and the check asserts instead that `buildPayload` for it reverts
 * `CurrencyDisabled`, the invariant the zero enforces. A zero for any other
 * currency fails, as does a listed currency that turns out to be enabled, so an
 * all-disabled deployment never passes by accident. The summary line prints
 * `disabled: N/M`.
 *
 * Exits non-zero on any mismatch, so it doubles as the acceptance record for a
 * deployment. Nothing is signed or broadcast.
 *
 * Required env vars:
 *   RPC_URL                      Hub chain RPC
 *   ALLOCATOR                    RelayAllocator address
 *   CONFIG                       Config store address
 *   PAYLOAD_BUILDER              LighterVmPayloadBuilder address
 *   CHAIN_ID                     Relay chain id string (`lighter`, `robinhood-lighter`)
 *   DEPOSITORY                   Depository account index (decimal, SDK-encoded here)
 *
 * Optional env vars:
 *   EXPECTED_LIGHTER_CHAIN_ID    Lighter app-chain id the builder must sign with;
 *                                defaults to the known app-chain id of CHAIN_ID
 *   CURRENCY_SET                 Currency set to verify; defaults to CHAIN_ID
 *   SAMPLE_RECEIVER              Account index used as the sample transfer
 *                                recipient (default: 1)
 *   EXPECT_VALUES                Per-currency expected `fromRouteType,toRouteType,
 *                                assetIndex` overriding the currency set, e.g.
 *                                "ETH Spot=2,2,7;USDC Spot=1,1,3" for values the
 *                                configure script carried over from a previous
 *                                builder; unlisted enabled currencies keep the
 *                                set defaults, an unknown label is an error, and
 *                                asset index 0 is rejected (use EXPECT_DISABLED)
 *   EXPECT_DISABLED              Comma-separated currency-set labels that are
 *                                meant to be disabled (asset index 0), e.g.
 *                                "ETH Spot,USDC Spot"; any other zero fails and
 *                                an unknown label is an error
 */

import { createPublicClient, http, parseAbi, bytesToHex } from "viem"
import type { Address, Hex } from "viem"
import { decodeWithdrawal, encodeAddress } from "@relay-protocol/settlement-sdk"

import {
  getLighterAppChainId,
  getLighterCurrencySet,
} from "./lighter-vm-currency-sets"
import type { LighterCurrencyConfig } from "./lighter-vm-currency-sets"
import { parseLabelList, ZERO_WORD } from "./lighter-vm-config-plan"

export type ExpectedValues = {
  fromRouteType: bigint
  toRouteType: bigint
  assetIndex: bigint
}

// "ETH Spot=2,2,7;USDC Spot=1,1,3" -> { "ETH Spot": {2,2,7}, "USDC Spot": {1,1,3} }
export const parseExpectValues = (
  value: string | undefined
): Record<string, ExpectedValues> => {
  const expected: Record<string, ExpectedValues> = {}
  for (const item of (value ?? "").split(";")) {
    const trimmed = item.trim()
    if (!trimmed) continue
    const match = /^(.+?)=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/.exec(trimmed)
    if (!match) {
      throw new Error(
        `EXPECT_VALUES entry "${trimmed}" is not "<label>=<fromRouteType>,<toRouteType>,<assetIndex>"`
      )
    }
    const [, label, fromRouteType, toRouteType, assetIndex] = match
    expected[label.trim()] = {
      assetIndex: BigInt(assetIndex),
      fromRouteType: BigInt(fromRouteType),
      toRouteType: BigInt(toRouteType),
    }
  }
  return expected
}

const builderAbi = parseAbi([
  "function CONFIG() view returns (address)",
  "function getFromAccountIndexKey(string chainId) view returns (bytes32)",
  "function getLighterChainIdKey(string chainId) view returns (bytes32)",
  "function family() view returns (string)",
  "function getFromRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getToRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getAssetIndexKey(string chainId, bytes currency) view returns (bytes32)",
  "function getMaxUsdcFee(string chainId) view returns (uint64)",
  "function buildPayload(string chainId, bytes depository, (string chainId, bytes depository, bytes currency, uint256 amount, string spenderChainId, bytes spender, bytes receiver, bytes data, bytes32 nonce) request) view returns (bytes, (bytes currency, uint256 amount) withdrawFee)",
  "error CurrencyDisabled(string chainId, bytes currency)",
])

// Sample spender/nonce for the read-only buildPayload probe. The builder folds the
// whole request into the transfer memo, which this check does not assert on.
const SAMPLE_SPENDER: Hex = `0x${"11".repeat(20)}`
const SAMPLE_NONCE: Hex = `0x${"00".repeat(32)}`

const allocatorAbi = parseAbi([
  "function payloadBuilders(string chainId, bytes depository) view returns (address)",
])

const configAbi = parseAbi([
  "function getConfigValue(bytes32 key) view returns (bytes32)",
])

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`set ${name}`)
  }
  return value
}

function asAddress(value: string, name: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address`)
  }
  return value as Address
}

const uint256Word = (value: bigint): Hex =>
  `0x${value.toString(16).padStart(64, "0")}`

export type Check = { label: string; ok: boolean; detail: string }

// Only the read surface the checks use, so tests can pass a plain mock.
export type ReadClient = {
  readContract: (_args: {
    abi: unknown
    address: Address
    args?: readonly unknown[]
    functionName: string
  }) => Promise<unknown>
}

// Fields of the decoded sample transfer the checks assert on.
export type DecodedTransfer = {
  fromAccountIndex: bigint
  lighterChainId: bigint
  fromRouteType: bigint
  toRouteType: bigint
  assetIndex: bigint
  toAccountIndex: bigint
  amount: bigint
  usdcFee: bigint
}

const decodeTransfer = (payload: Hex): DecodedTransfer => {
  const p = decodeWithdrawal(payload, "lighter-vm").withdrawal.parameters
  return {
    amount: BigInt(p.amount),
    assetIndex: BigInt(p.assetIndex),
    fromAccountIndex: BigInt(p.fromAccountIndex),
    fromRouteType: BigInt(p.fromRouteType),
    lighterChainId: BigInt(p.lighterChainId),
    toAccountIndex: BigInt(p.toAccountIndex),
    toRouteType: BigInt(p.toRouteType),
    usdcFee: BigInt(p.usdcFee),
  }
}

async function readConfigValue(
  client: ReadClient,
  config: Address,
  key: Hex
): Promise<Hex | undefined> {
  try {
    return (await client.readContract({
      abi: configAbi,
      address: config,
      args: [key],
      functionName: "getConfigValue",
    })) as Hex
  } catch {
    return undefined
  }
}

// Duck-typed so a client built on another viem copy is recognised too.
const isCurrencyDisabledRevert = (error: unknown): boolean => {
  const walk = (error as { walk?: (_fn: (_e: unknown) => boolean) => unknown })
    ?.walk
  if (typeof walk === "function") {
    const revert = walk.call(
      error,
      (e: unknown) =>
        (e as { data?: { errorName?: string } })?.data?.errorName ===
        "CurrencyDisabled"
    )
    if (revert !== null && revert !== undefined) return true
  }
  return error instanceof Error && /CurrencyDisabled/.test(error.message)
}

const firstLine = (error: unknown): string =>
  error instanceof Error ? error.message.split("\n")[0] : String(error)

export type CurrencyChecksInput = {
  client: ReadClient
  config: Address
  builder: Address
  chainId: string
  currencies: LighterCurrencyConfig[]
  depository: string
  depositoryEncoded: Hex
  expectedLighterChainId: bigint
  sampleReceiver: string
  // Labels of currencies meant to be disabled (asset index 0) on chain.
  expectDisabled?: string[]
  // Expected values per label where they differ from the currency set.
  expectValues?: Record<string, ExpectedValues>
  decodePayload?: (_payload: Hex) => DecodedTransfer
  log?: (_line: string) => void
}

export type CurrencyChecks = { checks: Check[]; disabled: number }

/**
 * Steps 3 and 4 for every currency: Config values against the currency set
 * and a decoded sample transfer. A currency whose asset index is zero passes
 * only when listed in `expectDisabled`: it is reported, its defaults are not
 * asserted, and `buildPayload` must revert `CurrencyDisabled` for it.
 */
export async function checkCurrencies(
  input: CurrencyChecksInput
): Promise<CurrencyChecks> {
  const {
    client,
    config,
    builder,
    chainId,
    currencies,
    depository,
    depositoryEncoded,
    expectedLighterChainId,
    sampleReceiver,
    expectDisabled = [],
    expectValues = {},
  } = input
  const decodePayload = input.decodePayload ?? decodeTransfer
  const log = input.log ?? console.log
  const checks: Check[] = []
  const record = (label: string, ok: boolean, detail: string) =>
    checks.push({ detail, label, ok })

  let disabled = 0
  const known = currencies.map((entry) => `"${entry.label}"`).join(", ")
  const unknownLabels = expectDisabled.filter(
    (label) => !currencies.some((entry) => entry.label === label)
  )
  if (unknownLabels.length > 0) {
    throw new Error(
      `EXPECT_DISABLED names no "${chainId}" currency: ${unknownLabels.map((label) => `"${label}"`).join(", ")} (known: ${known})`
    )
  }
  for (const [label, values] of Object.entries(expectValues)) {
    if (!currencies.some((entry) => entry.label === label)) {
      throw new Error(
        `EXPECT_VALUES names no "${chainId}" currency: "${label}" (known: ${known})`
      )
    }
    if (values.assetIndex === 0n) {
      throw new Error(
        `EXPECT_VALUES gives "${label}" asset index 0; a disabled currency is declared with EXPECT_DISABLED`
      )
    }
    if (expectDisabled.includes(label)) {
      throw new Error(
        `"${label}" is listed in both EXPECT_VALUES and EXPECT_DISABLED`
      )
    }
  }
  const expectedFor = (entry: LighterCurrencyConfig): ExpectedValues =>
    expectValues[entry.label] ?? {
      assetIndex: entry.assetIndex,
      fromRouteType: entry.routeType,
      toRouteType: entry.routeType,
    }

  const keyFor = async (
    fn: "getFromRouteTypeKey" | "getToRouteTypeKey" | "getAssetIndexKey",
    currency: Hex
  ) =>
    (await client.readContract({
      abi: builderAbi,
      address: builder,
      args: [chainId, currency],
      functionName: fn,
    })) as Hex

  const checkConfig = (
    entry: LighterCurrencyConfig,
    fn: "getFromRouteTypeKey" | "getToRouteTypeKey" | "getAssetIndexKey",
    value: Hex | undefined,
    expected: bigint
  ) =>
    record(
      `config.${entry.label}.${fn.replace(/^get|Key$/g, "")}`,
      value?.toLowerCase() === uint256Word(expected),
      `${value ?? "unset"} (expected ${uint256Word(expected)})`
    )

  const sampleData =
    `0x${1n.toString(16).padStart(64, "0")}` + // nonce
    4n.toString(16).padStart(64, "0") + // apiKeyIndex
    1_000_000n.toString(16).padStart(64, "0") // usdcFee = 1 USDC
  const buildPayload = async (entry: LighterCurrencyConfig): Promise<Hex> => {
    const [payload] = (await client.readContract({
      abi: builderAbi,
      address: builder,
      args: [
        chainId,
        depositoryEncoded,
        {
          amount: 5_000_000n,
          chainId,
          currency: entry.currency,
          data: sampleData as Hex,
          depository: depositoryEncoded,
          nonce: SAMPLE_NONCE,
          receiver: bytesToHex(encodeAddress(sampleReceiver, "lighter-vm")),
          spender: SAMPLE_SPENDER,
          spenderChainId: chainId,
        },
      ],
      functionName: "buildPayload",
    })) as readonly [Hex, { currency: Hex; amount: bigint }]
    return payload
  }

  for (const entry of currencies) {
    const [fromRoute, toRoute, assetIndex] = await Promise.all(
      (
        [
          "getFromRouteTypeKey",
          "getToRouteTypeKey",
          "getAssetIndexKey",
        ] as const
      ).map(async (fn) =>
        readConfigValue(client, config, await keyFor(fn, entry.currency))
      )
    )

    const expectedDisabled = expectDisabled.includes(entry.label)
    const expected = expectedFor(entry)
    if (assetIndex === ZERO_WORD) {
      disabled++
      if (!expectedDisabled) {
        record(
          `config.${entry.label}.AssetIndex`,
          false,
          `0 (disabled on chain; expected ${uint256Word(expected.assetIndex)} — add "${entry.label}" to EXPECT_DISABLED if intended)`
        )
        continue
      }
      log(
        `  [disabled] ${entry.label}: asset index 0 on chain; default values and sample transfer not asserted`
      )
      let detail: string
      let ok = false
      try {
        const payload = await buildPayload(entry)
        detail = `built a payload (${payload.length / 2 - 1} bytes) for a disabled currency; expected revert CurrencyDisabled`
      } catch (error) {
        ok = isCurrencyDisabledRevert(error)
        detail = ok
          ? "reverts CurrencyDisabled (currency disabled on chain)"
          : `revert: ${firstLine(error)} (expected CurrencyDisabled)`
      }
      record(
        `buildPayload(${entry.label}) reverts CurrencyDisabled`,
        ok,
        detail
      )
      continue
    }
    if (expectedDisabled) {
      record(
        `config.${entry.label}.AssetIndex`,
        false,
        `expected disabled, found ${assetIndex ?? "unset"} (listed in EXPECT_DISABLED)`
      )
      continue
    }

    checkConfig(entry, "getFromRouteTypeKey", fromRoute, expected.fromRouteType)
    checkConfig(entry, "getToRouteTypeKey", toRoute, expected.toRouteType)
    checkConfig(entry, "getAssetIndexKey", assetIndex, expected.assetIndex)

    let decodedLabel = "revert"
    let ok = false
    try {
      const p = decodePayload(await buildPayload(entry))
      ok =
        p.fromAccountIndex === BigInt(depository) &&
        p.lighterChainId === expectedLighterChainId &&
        p.fromRouteType === expected.fromRouteType &&
        p.toRouteType === expected.toRouteType &&
        p.assetIndex === expected.assetIndex &&
        p.toAccountIndex === BigInt(sampleReceiver)
      decodedLabel = `from=${p.fromAccountIndex} route=${p.fromRouteType}->${p.toRouteType} asset=${p.assetIndex} to=${p.toAccountIndex} chainId=${p.lighterChainId} amount=${p.amount} fee=${p.usdcFee}`
    } catch (error) {
      decodedLabel = `revert: ${firstLine(error)}`
    }
    record(`buildPayload(${entry.label})`, ok, decodedLabel)
  }

  return { checks, disabled }
}

async function main() {
  const rpcUrl = requireEnv("RPC_URL")
  const allocator = asAddress(requireEnv("ALLOCATOR"), "ALLOCATOR")
  const config = asAddress(requireEnv("CONFIG"), "CONFIG")
  const builder = asAddress(requireEnv("PAYLOAD_BUILDER"), "PAYLOAD_BUILDER")
  const chainId = requireEnv("CHAIN_ID")
  const depository = requireEnv("DEPOSITORY")
  const expectedLighterChainId = process.env.EXPECTED_LIGHTER_CHAIN_ID
    ? BigInt(process.env.EXPECTED_LIGHTER_CHAIN_ID)
    : getLighterAppChainId(chainId)
  const currencySet = process.env.CURRENCY_SET || chainId
  const currencies = getLighterCurrencySet(currencySet)
  const sampleReceiver = process.env.SAMPLE_RECEIVER || "1"
  const expectDisabled = parseLabelList(process.env.EXPECT_DISABLED)
  const expectValues = parseExpectValues(process.env.EXPECT_VALUES)

  const client = createPublicClient({ transport: http(rpcUrl) })
  // viem's generic readContract narrows its parameter type; the checks only
  // need the structural read surface.
  const reader = client as unknown as ReadClient
  const depositoryEncoded = bytesToHex(encodeAddress(depository, "lighter-vm"))
  const checks: Check[] = []
  const record = (label: string, ok: boolean, detail: string) =>
    checks.push({ detail, label, ok })

  console.log("Verifying Lighter VM payload builder")
  console.log(`  rpc:               ${rpcUrl}`)
  console.log(`  chainId:           ${chainId}`)
  console.log(`  currencySet:       ${currencySet}`)
  console.log(`  depository:        ${depository} (${depositoryEncoded})`)
  console.log(`  payloadBuilder:    ${builder}`)
  console.log(
    `  expectDisabled:    ${expectDisabled.length ? expectDisabled.join(", ") : "(none)"}`
  )
  console.log(
    `  expectValues:      ${
      Object.keys(expectValues).length
        ? Object.entries(expectValues)
            .map(
              ([label, v]) =>
                `${label}=${v.fromRouteType},${v.toRouteType},${v.assetIndex}`
            )
            .join("; ")
        : "(none)"
    }`
  )

  // 1. Builder wiring and instance config
  const [onChainConfig, family, fromAccountIndexKey, lighterChainIdKey] =
    await Promise.all([
      client.readContract({
        abi: builderAbi,
        address: builder,
        functionName: "CONFIG",
      }),
      client.readContract({
        abi: builderAbi,
        address: builder,
        functionName: "family",
      }),
      client.readContract({
        abi: builderAbi,
        address: builder,
        args: [chainId],
        functionName: "getFromAccountIndexKey",
      }),
      client.readContract({
        abi: builderAbi,
        address: builder,
        args: [chainId],
        functionName: "getLighterChainIdKey",
      }),
    ])
  const [fromAccountIndex, lighterChainId] = await Promise.all([
    readConfigValue(reader, config, fromAccountIndexKey),
    readConfigValue(reader, config, lighterChainIdKey),
  ])
  record(
    "builder.family",
    family === "lighter-vm",
    `${family} (expected lighter-vm)`
  )
  record(
    "builder.CONFIG",
    onChainConfig.toLowerCase() === config.toLowerCase(),
    `${onChainConfig} (expected ${config})`
  )
  record(
    "config.fromAccountIndex",
    fromAccountIndex?.toLowerCase() === uint256Word(BigInt(depository)),
    `${fromAccountIndex ?? "unset"} (expected ${uint256Word(BigInt(depository))})`
  )
  record(
    "config.lighterChainId",
    lighterChainId?.toLowerCase() === uint256Word(expectedLighterChainId),
    `${lighterChainId ?? "unset"} (expected ${uint256Word(expectedLighterChainId)})`
  )

  // 2. Allocator registration
  const registered = (await client.readContract({
    abi: allocatorAbi,
    address: allocator,
    args: [chainId, depositoryEncoded],
    functionName: "payloadBuilders",
  })) as Address
  record(
    `allocator.payloadBuilders(${chainId})`,
    registered.toLowerCase() === builder.toLowerCase(),
    `${registered} (expected ${builder})`
  )

  // Builders deployed before the fee bound (#770) have no getMaxUsdcFee.
  try {
    const maxUsdcFee = await client.readContract({
      abi: builderAbi,
      address: builder,
      args: [chainId],
      functionName: "getMaxUsdcFee",
    })
    console.log(`  maxUsdcFee:        ${maxUsdcFee} (USDC base units)`)
  } catch {
    console.log("  maxUsdcFee:        n/a (builder predates the fee bound)")
  }

  // 3 + 4. Config store values and sample payload per currency
  const currencyChecks = await checkCurrencies({
    builder,
    chainId,
    client: reader,
    config,
    currencies,
    depository,
    depositoryEncoded,
    expectDisabled,
    expectValues,
    expectedLighterChainId,
    sampleReceiver,
  })
  checks.push(...currencyChecks.checks)
  const disabledSummary = `disabled: ${currencyChecks.disabled}/${currencies.length}`

  console.log("")
  let failures = 0
  for (const check of checks) {
    if (!check.ok) failures++
    console.log(`  ${check.ok ? "✅" : "❌"} ${check.label}: ${check.detail}`)
  }
  console.log("")
  if (failures > 0) {
    console.log(`❌ ${failures} check(s) failed (${disabledSummary})`)
    process.exitCode = 1
  } else {
    console.log(`✅ all ${checks.length} checks passed (${disabledSummary})`)
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
