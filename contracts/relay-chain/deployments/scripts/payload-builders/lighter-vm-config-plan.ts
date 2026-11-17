/**
 * Plans the Config writes that seed a Lighter deployment on a
 * `LighterVmPayloadBuilder`, shared by the env-driven configure script and the
 * multisig manifest generators in `packages/multisig-tools`.
 *
 * Every key is resolved from the target builder's own getters and read back
 * from Config before it is written:
 *   - a key already set under the target builder is authoritative: it is
 *     never rewritten to the currency-set default, and drift is reported with
 *     a `[keep]` line; only unset keys, a persisted zero for a disabled
 *     currency and an explicit re-enable are written;
 *   - an asset index of zero marks a currency disabled (the builder reverts
 *     `CurrencyDisabled`), so a zero on chain is never overwritten with the
 *     currency set's default: the plan carries a `[disabled]` warning and
 *     keeps (or writes) zero under the target key while its route types, the
 *     instance keys and the other currencies are written as usual. A currency
 *     is re-enabled only when its label is listed in `reenableCurrencies` (env
 *     `REENABLE_CURRENCIES`, a comma-separated list of currency-set labels such
 *     as `ETH Spot,USDC Spot`, matched exactly); a label that matches no
 *     currency is an error;
 *   - when `previousPayloadBuilder` is given and a currency's target keys are
 *     unset, the currency is migrated: its route types and asset index are
 *     read under the previous builder's keys and those exact values are
 *     written to the target keys (a `[migrate]` line reports values that
 *     differ from the currency set). An unset legacy route type falls back to
 *     the currency-set default; a zero or unset legacy asset index means the
 *     route was disabled or never configured, and an explicit zero is written
 *     under the new key so later runs keep it disabled without any env;
 *   - an asset-index key unset while the currency's route-type keys are set is
 *     a half-migrated currency, refused unless `previousPayloadBuilder` or the
 *     label in `reenableCurrencies` is supplied; a currency whose three keys
 *     are all unset is a fresh one and is written;
 *   - `previousPayloadBuilder` must differ from the target, and a previous
 *     builder under which none of the currencies it is consulted for has a
 *     non-zero asset index is refused as a wrong address (the plan would
 *     disable every one of them) unless
 *     `confirmDisableAll` (env `CONFIRM_DISABLE_ALL=1`) confirms it or every
 *     label is in `reenableCurrencies`; `migrationReviewed` does not;
 *   - without a previous builder, a target whose currency keys are all unset
 *     is refused unless `migrationReviewed` (env `MIGRATION_REVIEWED=1`)
 *     confirms a first-time configuration.
 *
 * This module is imported from `packages/multisig-tools`, which resolves its
 * own copy of viem, so it never relies on `instanceof` viem error classes.
 */

import { parseAbi } from "viem"
import type { Address, Hex } from "viem"

import type { LighterCurrencyConfig } from "./lighter-vm-currency-sets"

// Only the read surface the planner uses, so tests can pass a plain mock.
export type ReadClient = {
  readContract: (_args: {
    abi: unknown
    address: Address
    args?: readonly unknown[]
    functionName: string
  }) => Promise<unknown>
}

export type ConfigWritePlan = {
  keys: Hex[]
  values: Hex[]
}

export type LighterConfigPlanInput = {
  client: ReadClient
  config: Address
  payloadBuilder: Address
  chainId: string
  currencies: LighterCurrencyConfig[]
  // Written by a config-driven builder; a legacy builder carries them as immutables.
  instance?: { fromAccountIndex: bigint; lighterChainId: bigint }
  // Builder being replaced, whose keys hold the values to carry over.
  previousPayloadBuilder?: Address
  // Labels of disabled currencies whose asset index may be written.
  reenableCurrencies?: string[]
  // Confirms a first-time configuration whose currency keys are all unset.
  migrationReviewed?: boolean
  // Confirms writing asset index 0 for every currency under a previous builder.
  confirmDisableAll?: boolean
  log?: (_line: string) => void
}

export const ZERO_WORD: Hex = `0x${"00".repeat(32)}`

// "ETH Spot,USDC Spot" -> ["ETH Spot", "USDC Spot"]
export const parseLabelList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0)

export const parseReenableCurrencies = parseLabelList

export const uint256Word = (value: bigint): Hex =>
  `0x${value.toString(16).padStart(64, "0")}`

// ConfigValueNotSet must be in this ABI so viem can name the revert.
export const lighterConfigAbi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
  "function getConfigValue(bytes32 key) view returns (bytes32)",
  "error ConfigValueNotSet(bytes32 key)",
])

export const lighterBuilderKeyAbi = parseAbi([
  "function getFromRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getToRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getAssetIndexKey(string chainId, bytes currency) view returns (bytes32)",
  "function getFromAccountIndexKey(string chainId) view returns (bytes32)",
  "function getLighterChainIdKey(string chainId) view returns (bytes32)",
])

// Duck-typed on purpose: the caller's viem may be another copy than ours.
const isConfigValueNotSet = (error: unknown): boolean => {
  const walk = (error as { walk?: (_fn: (_e: unknown) => boolean) => unknown })
    ?.walk
  if (typeof walk !== "function") return false
  const revert = walk.call(
    error,
    (e: unknown) =>
      (e as { data?: { errorName?: string } })?.data?.errorName ===
      "ConfigValueNotSet"
  )
  return revert !== null && revert !== undefined
}

// Returns undefined for a key the Config store has never been written.
export async function readConfigValue(
  client: ReadClient,
  config: Address,
  key: Hex
): Promise<Hex | undefined> {
  try {
    return (await client.readContract({
      abi: lighterConfigAbi,
      address: config,
      args: [key],
      functionName: "getConfigValue",
    })) as Hex
  } catch (error) {
    if (isConfigValueNotSet(error)) return undefined
    throw error
  }
}

const readBuilderKey = async (
  client: ReadClient,
  builder: Address,
  functionName: string,
  args: readonly unknown[]
): Promise<Hex> => {
  try {
    return (await client.readContract({
      abi: lighterBuilderKeyAbi,
      address: builder,
      args,
      functionName,
    })) as Hex
  } catch (error) {
    throw new Error(
      `LighterVmPayloadBuilder ${builder} has no ${functionName}(${args.map(() => "..").join(",")})`,
      { cause: error }
    )
  }
}

type CurrencyKeys = {
  entry: LighterCurrencyConfig
  fromRouteKey: Hex
  toRouteKey: Hex
  assetIndexKey: Hex
  current: {
    fromRoute: Hex | undefined
    toRoute: Hex | undefined
    assetIndex: Hex | undefined
  }
  // Values under the previous builder's keys, read when a target key is unset.
  legacy?: {
    assetIndexKey: Hex
    fromRoute: Hex | undefined
    toRoute: Hex | undefined
    assetIndex: Hex | undefined
  }
}

const isDisabledValue = (value: Hex | undefined): boolean =>
  value === undefined || value === ZERO_WORD

export async function planLighterConfigWrites(
  input: LighterConfigPlanInput
): Promise<ConfigWritePlan> {
  const {
    client,
    config,
    payloadBuilder,
    chainId,
    currencies,
    instance,
    previousPayloadBuilder,
    reenableCurrencies = [],
    migrationReviewed = false,
    confirmDisableAll = false,
  } = input
  const log = input.log ?? console.log
  const keys: Hex[] = []
  const values: Hex[] = []

  const unknownLabels = reenableCurrencies.filter(
    (label) => !currencies.some((entry) => entry.label === label)
  )
  if (unknownLabels.length > 0) {
    throw new Error(
      `REENABLE_CURRENCIES names no "${chainId}" currency: ${unknownLabels.map((label) => `"${label}"`).join(", ")} (known: ${currencies.map((entry) => `"${entry.label}"`).join(", ")})`
    )
  }
  if (
    previousPayloadBuilder &&
    previousPayloadBuilder.toLowerCase() === payloadBuilder.toLowerCase()
  ) {
    throw new Error(
      `PREVIOUS_PAYLOAD_BUILDER ${previousPayloadBuilder} is the target builder; pass the builder being replaced.`
    )
  }

  const push = (
    key: Hex,
    value: Hex,
    current: Hex | undefined,
    label: string
  ) => {
    if (current?.toLowerCase() === value.toLowerCase()) {
      log(`      [skip] ${label} already set key=${key}`)
      return
    }
    log(
      `      [set ] ${label} key=${key} value=${value} (was ${current ?? "unset"})`
    )
    keys.push(key)
    values.push(value)
  }

  if (instance) {
    log("==> Resolving Lighter instance config keys")
    const [fromAccountIndexKey, lighterChainIdKey] = await Promise.all([
      readBuilderKey(client, payloadBuilder, "getFromAccountIndexKey", [
        chainId,
      ]),
      readBuilderKey(client, payloadBuilder, "getLighterChainIdKey", [chainId]),
    ])
    push(
      fromAccountIndexKey,
      uint256Word(instance.fromAccountIndex),
      await readConfigValue(client, config, fromAccountIndexKey),
      `fromAccountIndex=${instance.fromAccountIndex}`
    )
    push(
      lighterChainIdKey,
      uint256Word(instance.lighterChainId),
      await readConfigValue(client, config, lighterChainIdKey),
      `lighterChainId=${instance.lighterChainId}`
    )
  }

  log("==> Resolving Lighter currency config keys")
  const resolved: CurrencyKeys[] = []
  for (const entry of currencies) {
    const [fromRouteKey, toRouteKey, assetIndexKey] = await Promise.all([
      readBuilderKey(client, payloadBuilder, "getFromRouteTypeKey", [
        chainId,
        entry.currency,
      ]),
      readBuilderKey(client, payloadBuilder, "getToRouteTypeKey", [
        chainId,
        entry.currency,
      ]),
      readBuilderKey(client, payloadBuilder, "getAssetIndexKey", [
        chainId,
        entry.currency,
      ]),
    ])
    const [fromRoute, toRoute, assetIndex] = await Promise.all([
      readConfigValue(client, config, fromRouteKey),
      readConfigValue(client, config, toRouteKey),
      readConfigValue(client, config, assetIndexKey),
    ])
    let legacy: CurrencyKeys["legacy"]
    if (
      previousPayloadBuilder &&
      (fromRoute === undefined ||
        toRoute === undefined ||
        assetIndex === undefined)
    ) {
      const legacyKeys = await Promise.all(
        (
          [
            "getFromRouteTypeKey",
            "getToRouteTypeKey",
            "getAssetIndexKey",
          ] as const
        ).map((fn) =>
          readBuilderKey(client, previousPayloadBuilder, fn, [
            chainId,
            entry.currency,
          ])
        )
      )
      const [legacyFromRoute, legacyToRoute, legacyAssetIndex] =
        await Promise.all(
          legacyKeys.map((legacyKey) =>
            readConfigValue(client, config, legacyKey)
          )
        )
      legacy = {
        assetIndex: legacyAssetIndex,
        assetIndexKey: legacyKeys[2],
        fromRoute: legacyFromRoute,
        toRoute: legacyToRoute,
      }
    }
    resolved.push({
      assetIndexKey,
      current: { assetIndex, fromRoute, toRoute },
      entry,
      fromRouteKey,
      legacy,
      toRouteKey,
    })
  }

  // Every currency key unset means either a first-time configuration or a
  // builder replacement whose disabled currencies must be carried over.
  const allUnset =
    resolved.length > 0 &&
    resolved.every(
      ({ current }) =>
        current.fromRoute === undefined &&
        current.toRoute === undefined &&
        current.assetIndex === undefined
    )
  if (allUnset && !previousPayloadBuilder && !migrationReviewed) {
    throw new Error(
      `every "${chainId}" currency key under builder ${payloadBuilder} is unset. If this builder replaces another, pass PREVIOUS_PAYLOAD_BUILDER so currencies disabled under its keys stay disabled; for a first-time configuration set MIGRATION_REVIEWED=1.`
    )
  }

  // A previous builder under which none of the currencies consulted for an
  // asset index has a non-zero value is far more likely a wrong address than
  // a chain with every one of those routes off; the plan would disable them.
  const consulted = resolved.filter(
    ({ current, legacy }) =>
      legacy !== undefined && current.assetIndex === undefined
  )
  const allConsultedDisabled =
    consulted.length > 0 &&
    consulted.every(({ legacy }) => isDisabledValue(legacy!.assetIndex))
  const everyConsultedListed = consulted.every(({ entry }) =>
    reenableCurrencies.includes(entry.label)
  )
  // MIGRATION_REVIEWED only covers the first-time case above: confirming a
  // fresh deployment must not also authorise disabling every currency.
  if (allConsultedDisabled && !everyConsultedListed && !confirmDisableAll) {
    throw new Error(
      `no "${chainId}" currency has a non-zero asset index under previous builder ${previousPayloadBuilder}; it looks like the wrong builder (checked: ${consulted.map(({ entry }) => `"${entry.label}"`).join(", ")}), and the plan would write asset index 0 for every one of them (their withdrawals would revert CurrencyDisabled). Check PREVIOUS_PAYLOAD_BUILDER; to disable them on purpose set CONFIRM_DISABLE_ALL=1, or list every one of their labels in REENABLE_CURRENCIES.`
    )
  }

  for (const {
    entry,
    fromRouteKey,
    toRouteKey,
    assetIndexKey,
    current,
    legacy,
  } of resolved) {
    const routeDefault = uint256Word(entry.routeType)
    const assetDefault = uint256Word(entry.assetIndex)
    const decimal = (value: Hex | undefined) =>
      value === undefined ? "unset" : BigInt(value).toString()
    log(
      `    currency=${entry.currency} (${entry.label}) routeType=${entry.routeType} assetIndex=${entry.assetIndex}`
    )

    // A set target key is authoritative: drift from the currency set is
    // reported, never rewritten. Only unset keys, a persisted 0 and an
    // explicit re-enable are written.
    const drifted =
      (current.fromRoute !== undefined && current.fromRoute !== routeDefault) ||
      (current.toRoute !== undefined && current.toRoute !== routeDefault) ||
      (current.assetIndex !== undefined &&
        current.assetIndex !== ZERO_WORD &&
        current.assetIndex !== assetDefault)
    if (drifted) {
      log(
        `      [keep] ${entry.label}: on-chain ${decimal(current.fromRoute)},${decimal(current.toRoute)},${decimal(current.assetIndex)} differs from set default ${entry.routeType},${entry.routeType},${entry.assetIndex}; not rewritten`
      )
    }

    // An unset target key takes the legacy value under a replacement builder,
    // else the currency-set default.
    const fill = (legacyValue: Hex | undefined) =>
      legacy ? (legacyValue ?? routeDefault) : routeDefault
    const fromRouteValue = current.fromRoute ?? fill(legacy?.fromRoute)
    const toRouteValue = current.toRoute ?? fill(legacy?.toRoute)
    if (current.fromRoute === undefined) {
      push(
        fromRouteKey,
        fromRouteValue,
        undefined,
        `${entry.label} fromRouteType`
      )
    }
    if (current.toRoute === undefined) {
      push(toRouteKey, toRouteValue, undefined, `${entry.label} toRouteType`)
    }

    // Where the currency is disabled: a zero on chain, or, when its new key is
    // unset under a replacement builder, a zero or unset legacy value. An
    // enabled asset index, on chain or legacy, is kept as is.
    let assetValue: Hex = current.assetIndex ?? assetDefault
    let disabledAt: { builder: Address; key: Hex; value: string } | undefined
    if (current.assetIndex === ZERO_WORD) {
      disabledAt = { builder: payloadBuilder, key: assetIndexKey, value: "0" }
    } else if (
      current.assetIndex === undefined &&
      legacy &&
      previousPayloadBuilder
    ) {
      log(
        `      previous builder ${previousPayloadBuilder} key=${legacy.assetIndexKey} value=${legacy.assetIndex ?? "unset"}`
      )
      if (isDisabledValue(legacy.assetIndex)) {
        disabledAt = {
          builder: previousPayloadBuilder,
          key: legacy.assetIndexKey,
          value: legacy.assetIndex === undefined ? "unset" : "0",
        }
      } else {
        assetValue = legacy.assetIndex as Hex
      }
    }
    const reenable = reenableCurrencies.includes(entry.label)
    if (disabledAt) {
      if (reenable) {
        log(
          `      [reenable] ${entry.label} assetIndex was ${disabledAt.value} under builder ${disabledAt.builder} key ${disabledAt.key}; writing ${assetDefault} (listed in REENABLE_CURRENCIES)`
        )
        push(
          assetIndexKey,
          assetDefault,
          current.assetIndex,
          `${entry.label} assetIndex`
        )
      } else {
        // Persist the disabled state under the target key so later runs keep
        // it without PREVIOUS_PAYLOAD_BUILDER.
        const action =
          current.assetIndex === ZERO_WORD ? "leaving it at 0" : "writing 0"
        log(
          `      [disabled] ${entry.label} assetIndex is ${disabledAt.value} under builder ${disabledAt.builder} key ${disabledAt.key}; ${action}, not ${assetDefault}. Add "${entry.label}" to REENABLE_CURRENCIES to re-enable it.`
        )
        push(
          assetIndexKey,
          ZERO_WORD,
          current.assetIndex,
          `${entry.label} assetIndex`
        )
      }
      continue
    }
    if (
      current.assetIndex === undefined &&
      !previousPayloadBuilder &&
      !reenable &&
      (current.fromRoute !== undefined || current.toRoute !== undefined)
    ) {
      // Route types without an asset index is a half-migrated currency, not a
      // fresh one: the default could re-enable a route held back earlier.
      throw new Error(
        `${entry.label} assetIndex is unset under builder ${payloadBuilder} while its route-type keys are set; refusing to write ${assetDefault}. Pass PREVIOUS_PAYLOAD_BUILDER or add "${entry.label}" to REENABLE_CURRENCIES.`
      )
    }
    if (
      legacy &&
      (fromRouteValue !== routeDefault ||
        toRouteValue !== routeDefault ||
        assetValue !== assetDefault)
    ) {
      log(
        `      [migrate] ${entry.label}: carried ${decimal(fromRouteValue)},${decimal(toRouteValue)},${decimal(assetValue)} (set default ${entry.routeType},${entry.routeType},${entry.assetIndex})`
      )
    }
    if (current.assetIndex === undefined) {
      push(assetIndexKey, assetValue, undefined, `${entry.label} assetIndex`)
    }
  }

  return { keys, values }
}
