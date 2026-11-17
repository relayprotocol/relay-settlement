import { describe, expect, it, vi } from "vitest"
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  keccak256,
  parseAbi,
  toBytes,
} from "viem"
import type { Address, Hex } from "viem"

import {
  parseReenableCurrencies,
  planLighterConfigWrites,
  ZERO_WORD,
} from "../../deployments/scripts/payload-builders/lighter-vm-config-plan"
import type {
  LighterConfigPlanInput,
  ReadClient,
} from "../../deployments/scripts/payload-builders/lighter-vm-config-plan"
import { LIGHTER_MAINNET_CURRENCIES } from "../../deployments/scripts/payload-builders/lighter-vm-currency-sets"

const builder = `0x${"a1".repeat(20)}` as Address
const previousBuilder = `0x${"b2".repeat(20)}` as Address
const configStore = `0x${"d4".repeat(20)}` as Address
const chainId = "lighter"
const depository = 730948n
const appChainId = 304n

const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

// Each builder derives its own keys, like the hashed vs legacy derivations.
const key = (
  address: Address,
  functionName: string,
  args: readonly unknown[]
): Hex => keccak256(toBytes(`${address}:${functionName}:${args.join(",")}`))

const configAbi = parseAbi(["error ConfigValueNotSet(bytes32 key)"])

// The revert viem raises for Config.getConfigValue on an unset key.
const notSet = (configKey: Hex) =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: configAbi,
      data: encodeErrorResult({
        abi: configAbi,
        args: [configKey],
        errorName: "ConfigValueNotSet",
      }),
      functionName: "getConfigValue",
    }),
    {
      abi: configAbi,
      args: [configKey],
      contractAddress: configStore,
      functionName: "getConfigValue",
    }
  )

// Config store holding every value the mainnet currency set would write.
const configured = (at: Address = builder): Record<string, Hex> => {
  const store: Record<string, Hex> = {
    [key(at, "getFromAccountIndexKey", [chainId])]: word(depository),
    [key(at, "getLighterChainIdKey", [chainId])]: word(appChainId),
  }
  for (const entry of LIGHTER_MAINNET_CURRENCIES) {
    store[key(at, "getFromRouteTypeKey", [chainId, entry.currency])] = word(
      entry.routeType
    )
    store[key(at, "getToRouteTypeKey", [chainId, entry.currency])] = word(
      entry.routeType
    )
    store[key(at, "getAssetIndexKey", [chainId, entry.currency])] = word(
      entry.assetIndex
    )
  }
  return store
}

const clientFor = (
  store: Record<string, Hex>,
  notSetError: (_key: Hex) => Error = notSet
) => {
  const readContract = vi.fn(
    async ({
      address,
      functionName,
      args,
    }: {
      address: Address
      functionName: string
      args?: readonly unknown[]
    }) => {
      if (functionName === "getConfigValue") {
        const configKey = args![0] as Hex
        const value = store[configKey]
        if (value === undefined) throw notSetError(configKey)
        return value
      }
      return key(address, functionName, args ?? [])
    }
  )
  return { client: { readContract } as unknown as ReadClient, readContract }
}

const plan = (
  client: ReadClient,
  overrides: Partial<LighterConfigPlanInput> = {}
) =>
  planLighterConfigWrites({
    chainId,
    client,
    config: configStore,
    currencies: LIGHTER_MAINNET_CURRENCIES,
    instance: { fromAccountIndex: depository, lighterChainId: appChainId },
    log: () => undefined,
    payloadBuilder: builder,
    ...overrides,
  })

const valueAt = (result: { keys: Hex[]; values: Hex[] }, k: Hex) =>
  result.values[result.keys.indexOf(k)]

const ethSpot = LIGHTER_MAINNET_CURRENCIES[1]
const usdcSpot = LIGHTER_MAINNET_CURRENCIES[2]
const lighterChainIdKey = key(builder, "getLighterChainIdKey", [chainId])
const ethSpotKeys = {
  assetIndex: key(builder, "getAssetIndexKey", [chainId, ethSpot.currency]),
  fromRoute: key(builder, "getFromRouteTypeKey", [chainId, ethSpot.currency]),
  toRoute: key(builder, "getToRouteTypeKey", [chainId, ethSpot.currency]),
}
const ethSpotAssetKey = ethSpotKeys.assetIndex
const usdcSpotAssetKey = key(builder, "getAssetIndexKey", [
  chainId,
  usdcSpot.currency,
])
const ethSpotLegacyAssetKey = key(previousBuilder, "getAssetIndexKey", [
  chainId,
  ethSpot.currency,
])

describe("parseReenableCurrencies", () => {
  it("splits a comma-separated label list", () => {
    expect(parseReenableCurrencies("ETH Spot, USDC Spot,")).toEqual([
      "ETH Spot",
      "USDC Spot",
    ])
    expect(parseReenableCurrencies(undefined)).toEqual([])
    expect(parseReenableCurrencies("")).toEqual([])
  })
})

describe("planLighterConfigWrites", () => {
  it("writes every key on a reviewed first-time configuration", async () => {
    const { client } = clientFor({})
    const result = await plan(client, { migrationReviewed: true })

    // 2 instance keys + 3 currencies x 3 keys
    expect(result.keys).toHaveLength(11)
    expect(result.values).toHaveLength(11)
    expect(result.keys[0]).toBe(
      key(builder, "getFromAccountIndexKey", [chainId])
    )
    expect(result.values[0]).toBe(word(depository))
    expect(valueAt(result, ethSpotAssetKey)).toBe(word(ethSpot.assetIndex))
  })

  it("refuses a builder whose currency keys are all unset without a previous builder", async () => {
    const { client } = clientFor({})
    await expect(plan(client)).rejects.toThrow(
      /every "lighter" currency key under builder .* is unset.*PREVIOUS_PAYLOAD_BUILDER.*MIGRATION_REVIEWED=1/
    )
    // CONFIRM_DISABLE_ALL is not a substitute for the first-time review.
    await expect(plan(client, { confirmDisableAll: true })).rejects.toThrow(
      /every "lighter" currency key under builder .* is unset/
    )
  })

  it("produces no write when every key already matches", async () => {
    const { client, readContract } = clientFor(configured())
    const result = await plan(client)

    expect(result.keys).toEqual([])
    expect(result.values).toEqual([])
    expect(
      readContract.mock.calls.filter(
        ([call]) => call.functionName === "getConfigValue"
      )
    ).toHaveLength(11)
  })

  it("writes only the keys whose value differs", async () => {
    const store = configured()
    store[lighterChainIdKey] = word(466324n)
    const { client } = clientFor(store)

    const result = await plan(client)
    expect(result.keys).toEqual([lighterChainIdKey])
    expect(result.values).toEqual([word(appChainId)])
  })

  it("omits the instance keys for a legacy builder", async () => {
    const { client, readContract } = clientFor(configured())
    const result = await plan(client, { instance: undefined })

    expect(result.keys).toEqual([])
    expect(
      readContract.mock.calls.map(([call]) => call.functionName)
    ).not.toContain("getFromAccountIndexKey")
  })

  it("leaves a currency disabled on chain at zero and writes everything else", async () => {
    const store = configured()
    store[lighterChainIdKey] = word(466324n)
    store[ethSpotAssetKey] = word(0n)
    const { client } = clientFor(store)
    const lines: string[] = []

    const result = await plan(client, { log: (line) => lines.push(line) })
    expect(result.keys).toEqual([lighterChainIdKey])
    expect(result.values).toEqual([word(appChainId)])
    expect(
      lines.some((line) =>
        /\[disabled\] ETH Spot assetIndex is 0 .*leaving it at 0/.test(line)
      )
    ).toBe(true)
  })

  it("re-enables a disabled currency listed in REENABLE_CURRENCIES", async () => {
    const store = configured()
    store[ethSpotAssetKey] = word(0n)
    const { client } = clientFor(store)

    const result = await plan(client, { reenableCurrencies: ["ETH Spot"] })
    expect(result.keys).toEqual([ethSpotAssetKey])
    expect(result.values).toEqual([word(ethSpot.assetIndex)])
  })

  it("re-enables only the listed currency", async () => {
    const store = configured()
    store[ethSpotAssetKey] = word(0n)
    store[usdcSpotAssetKey] = word(0n)
    const { client } = clientFor(store)

    const result = await plan(client, { reenableCurrencies: ["USDC Spot"] })
    expect(result.keys).toEqual([usdcSpotAssetKey])
    expect(result.values).toEqual([word(usdcSpot.assetIndex)])
  })

  it("rejects a REENABLE_CURRENCIES label that matches no currency", async () => {
    const { client } = clientFor(configured())
    await expect(
      plan(client, { reenableCurrencies: ["ETH Spot", "eth spot"] })
    ).rejects.toThrow(
      /REENABLE_CURRENCIES names no "lighter" currency: "eth spot" \(known: "USDC Perp", "ETH Spot", "USDC Spot"\)/
    )
  })

  it("refuses to write an unset asset index whose route-type keys are set without a previous builder", async () => {
    const store = configured()
    delete store[ethSpotAssetKey]
    const { client } = clientFor(store)

    await expect(plan(client)).rejects.toThrow(
      new RegExp(
        `ETH Spot assetIndex is unset under builder ${builder} while its route-type keys are set; refusing to write ${word(ethSpot.assetIndex)}. Pass PREVIOUS_PAYLOAD_BUILDER or add "ETH Spot" to REENABLE_CURRENCIES.`
      )
    )
  })

  it("writes an unset asset index whose route-type keys are set when the label is listed", async () => {
    const store = configured()
    delete store[ethSpotAssetKey]
    const { client } = clientFor(store)

    const result = await plan(client, { reenableCurrencies: ["ETH Spot"] })
    expect(result.keys).toEqual([ethSpotAssetKey])
    expect(result.values).toEqual([word(ethSpot.assetIndex)])
  })

  it("writes a fresh currency whose three keys are all unset", async () => {
    const store = configured()
    delete store[ethSpotKeys.fromRoute]
    delete store[ethSpotKeys.toRoute]
    delete store[ethSpotAssetKey]
    const { client } = clientFor(store)

    const result = await plan(client)
    expect(result.keys).toEqual([
      ethSpotKeys.fromRoute,
      ethSpotKeys.toRoute,
      ethSpotAssetKey,
    ])
    expect(result.values).toEqual([
      word(ethSpot.routeType),
      word(ethSpot.routeType),
      word(ethSpot.assetIndex),
    ])
  })

  describe("with a previous builder", () => {
    const withPrevious = (overrides: Partial<LighterConfigPlanInput> = {}) => ({
      previousPayloadBuilder: previousBuilder,
      ...overrides,
    })

    it("rejects a previous builder equal to the target", async () => {
      const { client } = clientFor({})
      await expect(
        plan(client, { previousPayloadBuilder: builder })
      ).rejects.toThrow(
        `PREVIOUS_PAYLOAD_BUILDER ${builder} is the target builder`
      )
    })

    it("refuses a previous builder under which no currency is enabled", async () => {
      const { client } = clientFor({})
      await expect(plan(client, withPrevious())).rejects.toThrow(
        new RegExp(
          `no "lighter" currency has a non-zero asset index under previous builder ${previousBuilder}; it looks like the wrong builder.*CONFIRM_DISABLE_ALL=1`
        )
      )
    })

    it("does not let MIGRATION_REVIEWED alone disable every currency", async () => {
      const { client } = clientFor({})
      await expect(
        plan(client, withPrevious({ migrationReviewed: true }))
      ).rejects.toThrow(/looks like the wrong builder.*CONFIRM_DISABLE_ALL=1/)
    })

    it("disables every currency under a previous builder with none enabled only with CONFIRM_DISABLE_ALL", async () => {
      const { client } = clientFor({})
      const result = await plan(
        client,
        withPrevious({ confirmDisableAll: true })
      )
      expect(result.keys).toHaveLength(11)
      for (const entry of LIGHTER_MAINNET_CURRENCIES) {
        expect(
          valueAt(
            result,
            key(builder, "getAssetIndexKey", [chainId, entry.currency])
          )
        ).toBe(ZERO_WORD)
      }
    })

    it("enables every currency under a previous builder with none enabled when every label is listed", async () => {
      const { client } = clientFor({})
      const result = await plan(
        client,
        withPrevious({
          reenableCurrencies: LIGHTER_MAINNET_CURRENCIES.map((e) => e.label),
        })
      )
      expect(result.keys).toHaveLength(11)
      expect(valueAt(result, ethSpotAssetKey)).toBe(word(ethSpot.assetIndex))
    })

    it("keeps the per-currency behaviour when one currency is enabled under the previous builder", async () => {
      const usdcPerp = LIGHTER_MAINNET_CURRENCIES[0]
      const { client } = clientFor({
        [key(previousBuilder, "getAssetIndexKey", [
          chainId,
          usdcPerp.currency,
        ])]: word(usdcPerp.assetIndex),
      })
      const result = await plan(client, withPrevious())
      expect(result.keys).toHaveLength(11)
      expect(
        valueAt(
          result,
          key(builder, "getAssetIndexKey", [chainId, usdcPerp.currency])
        )
      ).toBe(word(usdcPerp.assetIndex))
      expect(valueAt(result, ethSpotAssetKey)).toBe(ZERO_WORD)
      expect(valueAt(result, usdcSpotAssetKey)).toBe(ZERO_WORD)
    })

    it("needs no migration review when the currency keys are all unset", async () => {
      const { client } = clientFor(configured(previousBuilder))
      const result = await plan(client, withPrevious())

      // Instance keys and every currency key move to the new derivation.
      expect(result.keys).toHaveLength(11)
      expect(valueAt(result, ethSpotAssetKey)).toBe(word(ethSpot.assetIndex))
    })

    for (const [state, legacy] of [
      ["disabled", word(0n)],
      ["never configured", undefined],
    ] as const) {
      it(`persists zero for a currency ${state} under the previous builder's key`, async () => {
        const store = configured(previousBuilder)
        if (legacy) store[ethSpotLegacyAssetKey] = legacy
        else delete store[ethSpotLegacyAssetKey]
        const { client } = clientFor(store)
        const lines: string[] = []

        const result = await plan(
          client,
          withPrevious({ log: (line) => lines.push(line) })
        )
        expect(result.keys).toHaveLength(11)
        expect(valueAt(result, ethSpotAssetKey)).toBe(ZERO_WORD)
        expect(valueAt(result, ethSpotKeys.fromRoute)).toBe(
          word(ethSpot.routeType)
        )
        expect(
          lines.some((line) =>
            new RegExp(
              `\\[disabled\\] ETH Spot assetIndex is ${legacy ? "0" : "unset"} under builder ${previousBuilder} key ${ethSpotLegacyAssetKey}; writing 0`
            ).test(line)
          )
        ).toBe(true)
      })

      it(`re-enables a currency ${state} under the previous builder when listed`, async () => {
        const store = configured(previousBuilder)
        if (legacy) store[ethSpotLegacyAssetKey] = legacy
        else delete store[ethSpotLegacyAssetKey]
        const { client } = clientFor(store)

        const result = await plan(
          client,
          withPrevious({ reenableCurrencies: ["ETH Spot"] })
        )
        expect(result.keys).toHaveLength(11)
        expect(valueAt(result, ethSpotAssetKey)).toBe(word(ethSpot.assetIndex))
      })
    }

    it("keeps the persisted zero on a later run without any env", async () => {
      // State after the migration run above landed: new keys set, ETH Spot at 0.
      const store = configured()
      store[ethSpotAssetKey] = word(0n)
      const { client, readContract } = clientFor(store)

      const result = await plan(client)
      expect(result.keys).toEqual([])
      expect(
        readContract.mock.calls.filter(
          ([call]) => call.address === previousBuilder
        )
      ).toHaveLength(0)

      // Only REENABLE_CURRENCIES flips it back to the default.
      const flipped = await plan(client, { reenableCurrencies: ["ETH Spot"] })
      expect(flipped.keys).toEqual([ethSpotAssetKey])
      expect(flipped.values).toEqual([word(ethSpot.assetIndex)])
    })

    it("carries a non-default legacy asset index over as it is", async () => {
      const store = configured()
      delete store[ethSpotAssetKey]
      store[ethSpotLegacyAssetKey] = word(7n)
      const { client } = clientFor(store)
      const lines: string[] = []

      const result = await plan(
        client,
        withPrevious({ log: (line) => lines.push(line) })
      )
      expect(result.keys).toEqual([ethSpotAssetKey])
      expect(result.values).toEqual([word(7n)])
      expect(lines).toContain(
        "      [migrate] ETH Spot: carried 1,1,7 (set default 1,1,1)"
      )
    })

    it("migrates a currency's legacy route types and asset index exactly", async () => {
      const legacyKey = (fn: string) =>
        key(previousBuilder, fn, [chainId, ethSpot.currency])
      const store = configured(previousBuilder)
      store[legacyKey("getFromRouteTypeKey")] = word(2n)
      store[legacyKey("getToRouteTypeKey")] = word(2n)
      store[legacyKey("getAssetIndexKey")] = word(7n)
      const { client } = clientFor(store)
      const lines: string[] = []

      const result = await plan(
        client,
        withPrevious({ log: (line) => lines.push(line) })
      )
      expect(result.keys).toHaveLength(11)
      expect(valueAt(result, ethSpotKeys.fromRoute)).toBe(word(2n))
      expect(valueAt(result, ethSpotKeys.toRoute)).toBe(word(2n))
      expect(valueAt(result, ethSpotAssetKey)).toBe(word(7n))
      // The other currencies carry the set defaults, so no [migrate] line.
      expect(lines.filter((line) => line.includes("[migrate]"))).toEqual([
        "      [migrate] ETH Spot: carried 2,2,7 (set default 1,1,1)",
      ])

      // Apply run 1; run 2 with no env must not touch the carried values.
      const migrated: Record<string, Hex> = { ...store }
      result.keys.forEach((k, i) => {
        migrated[k] = result.values[i]
      })
      const second: string[] = []
      const rerun = await plan(clientFor(migrated).client, {
        log: (line) => second.push(line),
      })
      expect(rerun.keys).toEqual([])
      expect(second).toContain(
        "      [keep] ETH Spot: on-chain 2,2,7 differs from set default 1,1,1; not rewritten"
      )
    })

    it("never rewrites set keys that drifted from the currency set", async () => {
      const store = configured()
      store[ethSpotKeys.fromRoute] = word(2n)
      store[ethSpotKeys.toRoute] = word(2n)
      store[ethSpotAssetKey] = word(7n)
      const { client } = clientFor(store)
      const lines: string[] = []

      const result = await plan(client, { log: (line) => lines.push(line) })
      expect(result.keys).toEqual([])
      expect(lines).toContain(
        "      [keep] ETH Spot: on-chain 2,2,7 differs from set default 1,1,1; not rewritten"
      )
      // Listing it in REENABLE_CURRENCIES changes nothing for an enabled currency.
      const listed = await plan(client, { reenableCurrencies: ["ETH Spot"] })
      expect(listed.keys).toEqual([])
    })

    it("falls back to the set default for an unset legacy route type", async () => {
      const legacyKey = (fn: string) =>
        key(previousBuilder, fn, [chainId, ethSpot.currency])
      const store = configured(previousBuilder)
      delete store[legacyKey("getFromRouteTypeKey")]
      store[legacyKey("getToRouteTypeKey")] = word(2n)
      store[legacyKey("getAssetIndexKey")] = word(7n)
      const { client } = clientFor(store)

      const result = await plan(client, withPrevious())
      expect(valueAt(result, ethSpotKeys.fromRoute)).toBe(
        word(ethSpot.routeType)
      )
      expect(valueAt(result, ethSpotKeys.toRoute)).toBe(word(2n))
      expect(valueAt(result, ethSpotAssetKey)).toBe(word(7n))
    })

    it("refuses a previous builder with none of the consulted currencies enabled on a partially set target", async () => {
      // USDC Perp is already migrated; ETH Spot and USDC Spot consult the
      // previous builder, which has nothing under their keys.
      const usdcPerp = LIGHTER_MAINNET_CURRENCIES[0]
      const { client } = clientFor({
        [key(builder, "getAssetIndexKey", [chainId, usdcPerp.currency])]: word(
          usdcPerp.assetIndex
        ),
      })

      await expect(plan(client, withPrevious())).rejects.toThrow(
        /looks like the wrong builder \(checked: "ETH Spot", "USDC Spot"\).*CONFIRM_DISABLE_ALL=1/
      )
      const result = await plan(
        client,
        withPrevious({ confirmDisableAll: true })
      )
      expect(valueAt(result, ethSpotAssetKey)).toBe(ZERO_WORD)
      expect(valueAt(result, usdcSpotAssetKey)).toBe(ZERO_WORD)
      expect(result.keys).not.toContain(
        key(builder, "getAssetIndexKey", [chainId, usdcPerp.currency])
      )
    })

    it("does not consult the previous builder for a key already set", async () => {
      const store = configured()
      store[ethSpotLegacyAssetKey] = word(0n)
      const { client, readContract } = clientFor(store)

      const result = await plan(client, withPrevious())
      expect(result.keys).toEqual([])
      expect(
        readContract.mock.calls.filter(
          ([call]) => call.address === previousBuilder
        )
      ).toHaveLength(0)
    })

    it("refuses a previous builder without the key getters", async () => {
      const { client } = clientFor({})
      const failing: ReadClient = {
        readContract: async (args) => {
          if (args.address === previousBuilder) {
            throw new Error("execution reverted")
          }
          return client.readContract(args)
        },
      }

      // Whichever currency-key getter the legacy read reaches first is named.
      await expect(plan(failing, withPrevious())).rejects.toThrow(
        new RegExp(
          `LighterVmPayloadBuilder ${previousBuilder} has no get(FromRouteType|ToRouteType|AssetIndex)Key\\(\\.\\.,\\.\\.\\)`
        )
      )
    })
  })

  it("treats a wrapped ConfigValueNotSet revert from another viem copy as unset", async () => {
    const wrapped = () => {
      const revert = new ContractFunctionRevertedError({
        abi: configAbi,
        data: `0x${"00".repeat(4)}` as Hex,
        functionName: "getConfigValue",
      })
      Object.assign(revert, { data: { errorName: "ConfigValueNotSet" } })
      return new BaseError("reverted", { cause: revert })
    }
    const store = configured()
    delete store[ethSpotKeys.fromRoute]
    delete store[ethSpotKeys.toRoute]
    delete store[ethSpotAssetKey]
    const { client } = clientFor(store, wrapped)

    const result = await plan(client)
    expect(result.keys).toEqual([
      ethSpotKeys.fromRoute,
      ethSpotKeys.toRoute,
      ethSpotAssetKey,
    ])
  })

  it("propagates Config reads that fail for another reason", async () => {
    const { client } = clientFor(configured())
    const failing: ReadClient = {
      readContract: async (args) => {
        if (args.functionName === "getConfigValue") {
          throw new Error("execution reverted")
        }
        return client.readContract(args)
      },
    }

    await expect(plan(failing)).rejects.toThrow(/execution reverted/)
  })
})
