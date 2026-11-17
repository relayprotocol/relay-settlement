import { describe, expect, it, vi } from "vitest"
import {
  BaseError,
  ContractFunctionRevertedError,
  keccak256,
  parseAbi,
  toBytes,
} from "viem"
import type { Address, Hex } from "viem"

import {
  checkCurrencies,
  parseExpectValues,
} from "../../deployments/scripts/payload-builders/verify-lighter-vm-payload-builder"
import type {
  CurrencyChecksInput,
  DecodedTransfer,
  ReadClient,
} from "../../deployments/scripts/payload-builders/verify-lighter-vm-payload-builder"
import { LIGHTER_MAINNET_CURRENCIES } from "../../deployments/scripts/payload-builders/lighter-vm-currency-sets"

const builder = `0x${"a1".repeat(20)}` as Address
const configStore = `0x${"d4".repeat(20)}` as Address
const chainId = "lighter"
const depository = "730948"
const depositoryEncoded = "0x000000000000000000000000000b2744" as Hex
const appChainId = 304n
const sampleReceiver = "1"

const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

const key = (functionName: string, currency: Hex): Hex =>
  keccak256(toBytes(`${functionName}:${chainId}:${currency}`))

const ethSpot = LIGHTER_MAINNET_CURRENCIES[1]
const allLabels = LIGHTER_MAINNET_CURRENCIES.map((e) => e.label)

// Config store holding the mainnet currency set as configured.
const configured = (): Record<string, Hex> => {
  const store: Record<string, Hex> = {}
  for (const entry of LIGHTER_MAINNET_CURRENCIES) {
    store[key("getFromRouteTypeKey", entry.currency)] = word(entry.routeType)
    store[key("getToRouteTypeKey", entry.currency)] = word(entry.routeType)
    store[key("getAssetIndexKey", entry.currency)] = word(entry.assetIndex)
  }
  return store
}

const withDisabled = (...labels: string[]): Record<string, Hex> => {
  const store = configured()
  for (const entry of LIGHTER_MAINNET_CURRENCIES) {
    if (labels.includes(entry.label)) {
      store[key("getAssetIndexKey", entry.currency)] = word(0n)
    }
  }
  return store
}

// The revert viem raises for a disabled currency.
const currencyDisabled = (currency: Hex) => {
  const revert = new ContractFunctionRevertedError({
    abi: parseAbi(["error CurrencyDisabled(string chainId, bytes currency)"]),
    data: `0x${"00".repeat(4)}` as Hex,
    functionName: "buildPayload",
  })
  Object.assign(revert, {
    data: { args: [chainId, currency], errorName: "CurrencyDisabled" },
  })
  return new BaseError("reverted", { cause: revert })
}

// A mock builder: buildPayload reverts CurrencyDisabled for a zero asset index
// and otherwise returns a payload the mock decoder maps back to the request.
const clientFor = (
  store: Record<string, Hex>,
  options: { buildDisabledAnyway?: boolean } = {}
) => {
  const readContract = vi.fn(
    async ({
      functionName,
      args,
    }: {
      functionName: string
      args?: readonly unknown[]
    }) => {
      if (functionName === "getConfigValue") {
        const value = store[args![0] as Hex]
        if (value === undefined) throw new Error("ConfigValueNotSet")
        return value
      }
      if (functionName === "buildPayload") {
        const request = args![2] as { currency: Hex }
        const assetIndex = store[key("getAssetIndexKey", request.currency)]
        if (assetIndex === word(0n) && !options.buildDisabledAnyway) {
          throw currencyDisabled(request.currency)
        }
        return [request.currency, { currency: "0x", amount: 0n }]
      }
      return key(functionName, args![1] as Hex)
    }
  )
  return { client: { readContract } as unknown as ReadClient, readContract }
}

// Decodes the mock payload (the request currency) into the configured transfer.
const decodePayload =
  (store: Record<string, Hex>) =>
  (payload: Hex): DecodedTransfer => ({
    amount: 5_000_000n,
    assetIndex: BigInt(store[key("getAssetIndexKey", payload)] ?? 0n),
    fromAccountIndex: BigInt(depository),
    fromRouteType: BigInt(store[key("getFromRouteTypeKey", payload)] ?? 0n),
    lighterChainId: appChainId,
    toAccountIndex: BigInt(sampleReceiver),
    toRouteType: BigInt(store[key("getToRouteTypeKey", payload)] ?? 0n),
    usdcFee: 1_000_000n,
  })

const run = (
  store: Record<string, Hex>,
  overrides: Partial<CurrencyChecksInput> = {},
  clientOptions: { buildDisabledAnyway?: boolean } = {}
) => {
  const lines: string[] = []
  const { client } = clientFor(store, clientOptions)
  const result = checkCurrencies({
    builder,
    chainId,
    client,
    config: configStore,
    currencies: LIGHTER_MAINNET_CURRENCIES,
    decodePayload: decodePayload(store),
    depository,
    depositoryEncoded,
    expectedLighterChainId: appChainId,
    log: (line) => lines.push(line),
    sampleReceiver,
    ...overrides,
  })
  return { lines, result }
}

const failures = (checks: { ok: boolean }[]) => checks.filter((c) => !c.ok)

const unexpectedZero = (label: string, expected: bigint) => ({
  detail: `0 (disabled on chain; expected ${word(expected)} — add "${label}" to EXPECT_DISABLED if intended)`,
  label: `config.${label}.AssetIndex`,
  ok: false,
})

describe("verify-lighter-vm-payload-builder currency checks", () => {
  it("passes every check on a fully enabled currency set", async () => {
    const { lines, result } = run(configured())
    const { checks, disabled } = await result

    // 3 currencies x (3 config checks + 1 sample payload)
    expect(checks).toHaveLength(12)
    expect(failures(checks)).toEqual([])
    expect(disabled).toBe(0)
    expect(lines).toEqual([])
  })

  it("fails a currency whose asset index drifted from the set", async () => {
    const store = configured()
    store[key("getAssetIndexKey", ethSpot.currency)] = word(9n)
    const { checks } = await run(store).result

    expect(failures(checks).map((c) => c.label)).toEqual([
      "config.ETH Spot.AssetIndex",
      "buildPayload(ETH Spot)",
    ])
  })

  it("fails an unexpected zero asset index", async () => {
    const { lines, result } = run(withDisabled("ETH Spot"))
    const { checks, disabled } = await result

    expect(failures(checks)).toEqual([
      unexpectedZero("ETH Spot", ethSpot.assetIndex),
    ])
    expect(disabled).toBe(1)
    expect(lines).toEqual([])
  })

  it("accepts a zero asset index listed in EXPECT_DISABLED when buildPayload reverts CurrencyDisabled", async () => {
    const { lines, result } = run(withDisabled("ETH Spot"), {
      expectDisabled: ["ETH Spot"],
    })
    const { checks, disabled } = await result

    expect(failures(checks)).toEqual([])
    expect(disabled).toBe(1)
    expect(lines).toEqual([
      "  [disabled] ETH Spot: asset index 0 on chain; default values and sample transfer not asserted",
    ])
    // No default-equality or sample-transfer checks for the disabled currency.
    expect(checks.map((c) => c.label)).not.toContain(
      "config.ETH Spot.AssetIndex"
    )
    expect(checks.map((c) => c.label)).not.toContain("buildPayload(ETH Spot)")
    expect(checks).toContainEqual({
      detail: "reverts CurrencyDisabled (currency disabled on chain)",
      label: "buildPayload(ETH Spot) reverts CurrencyDisabled",
      ok: true,
    })
    // The other currencies keep their full checks.
    expect(checks).toHaveLength(9)
  })

  it("fails a currency listed in EXPECT_DISABLED that is actually enabled", async () => {
    const { checks, disabled } = await run(configured(), {
      expectDisabled: ["ETH Spot"],
    }).result

    expect(failures(checks)).toEqual([
      {
        detail: `expected disabled, found ${word(ethSpot.assetIndex)} (listed in EXPECT_DISABLED)`,
        label: "config.ETH Spot.AssetIndex",
        ok: false,
      },
    ])
    expect(disabled).toBe(0)
  })

  it("passes an all-disabled deployment only when every currency is listed", async () => {
    const { checks, disabled } = await run(withDisabled(...allLabels), {
      expectDisabled: allLabels,
    }).result

    expect(failures(checks)).toEqual([])
    expect(disabled).toBe(3)
    expect(checks.map((c) => c.label)).toEqual(
      allLabels.map(
        (label) => `buildPayload(${label}) reverts CurrencyDisabled`
      )
    )
  })

  it("fails an all-disabled deployment when nothing is listed", async () => {
    const { checks, disabled } = await run(withDisabled(...allLabels)).result

    expect(failures(checks)).toEqual(
      LIGHTER_MAINNET_CURRENCIES.map((e) =>
        unexpectedZero(e.label, e.assetIndex)
      )
    )
    expect(disabled).toBe(3)
  })

  describe("EXPECT_VALUES", () => {
    const carried = (): Record<string, Hex> => {
      const store = configured()
      store[key("getFromRouteTypeKey", ethSpot.currency)] = word(2n)
      store[key("getToRouteTypeKey", ethSpot.currency)] = word(2n)
      store[key("getAssetIndexKey", ethSpot.currency)] = word(7n)
      return store
    }
    const ethSpot227 = {
      "ETH Spot": { assetIndex: 7n, fromRouteType: 2n, toRouteType: 2n },
    }

    it("parses label=from,to,asset entries", () => {
      expect(parseExpectValues("ETH Spot=2,2,7; USDC Spot = 1, 1, 3;")).toEqual(
        {
          "ETH Spot": { assetIndex: 7n, fromRouteType: 2n, toRouteType: 2n },
          "USDC Spot": { assetIndex: 3n, fromRouteType: 1n, toRouteType: 1n },
        }
      )
      expect(parseExpectValues(undefined)).toEqual({})
      expect(() => parseExpectValues("ETH Spot=2,2")).toThrow(
        /EXPECT_VALUES entry "ETH Spot=2,2" is not/
      )
    })

    it("passes carried values that match", async () => {
      const { checks, disabled } = await run(carried(), {
        expectValues: ethSpot227,
      }).result
      expect(failures(checks)).toEqual([])
      expect(checks).toHaveLength(12)
      expect(disabled).toBe(0)
    })

    it("fails carried values without the override", async () => {
      const { checks } = await run(carried()).result
      expect(failures(checks).map((c) => c.label)).toEqual([
        "config.ETH Spot.FromRouteType",
        "config.ETH Spot.ToRouteType",
        "config.ETH Spot.AssetIndex",
        "buildPayload(ETH Spot)",
      ])
    })

    it("fails a listed currency whose chain values differ from the override", async () => {
      const { checks } = await run(configured(), {
        expectValues: ethSpot227,
      }).result
      expect(failures(checks).map((c) => c.label)).toEqual([
        "config.ETH Spot.FromRouteType",
        "config.ETH Spot.ToRouteType",
        "config.ETH Spot.AssetIndex",
        "buildPayload(ETH Spot)",
      ])
    })

    it("rejects an unknown label, asset index 0, and a label also in EXPECT_DISABLED", async () => {
      await expect(
        run(configured(), {
          expectValues: {
            "USDG Perp": { assetIndex: 3n, fromRouteType: 0n, toRouteType: 0n },
          },
        }).result
      ).rejects.toThrow(
        /EXPECT_VALUES names no "lighter" currency: "USDG Perp"/
      )
      await expect(
        run(configured(), {
          expectValues: {
            "ETH Spot": { assetIndex: 0n, fromRouteType: 1n, toRouteType: 1n },
          },
        }).result
      ).rejects.toThrow(
        /EXPECT_VALUES gives "ETH Spot" asset index 0; a disabled currency is declared with EXPECT_DISABLED/
      )
      await expect(
        run(withDisabled("ETH Spot"), {
          expectDisabled: ["ETH Spot"],
          expectValues: ethSpot227,
        }).result
      ).rejects.toThrow(
        /"ETH Spot" is listed in both EXPECT_VALUES and EXPECT_DISABLED/
      )
    })
  })

  it("rejects an EXPECT_DISABLED label outside the currency set", async () => {
    await expect(
      run(configured(), { expectDisabled: ["USDG Perp"] }).result
    ).rejects.toThrow(
      /EXPECT_DISABLED names no "lighter" currency: "USDG Perp" \(known: "USDC Perp", "ETH Spot", "USDC Spot"\)/
    )
  })

  it("fails a listed disabled currency whose buildPayload does not revert", async () => {
    const { checks } = await run(
      withDisabled("ETH Spot"),
      { expectDisabled: ["ETH Spot"] },
      { buildDisabledAnyway: true }
    ).result

    expect(failures(checks)).toEqual([
      {
        detail:
          "built a payload (16 bytes) for a disabled currency; expected revert CurrencyDisabled",
        label: "buildPayload(ETH Spot) reverts CurrencyDisabled",
        ok: false,
      },
    ])
  })

  it("fails a listed disabled currency whose buildPayload reverts for another reason", async () => {
    const store = withDisabled("ETH Spot")
    const { client } = clientFor(store)
    const failing: ReadClient = {
      readContract: async (args) => {
        if (
          args.functionName === "buildPayload" &&
          (args.args![2] as { currency: Hex }).currency === ethSpot.currency
        ) {
          throw new Error("ConfigValueNotSet")
        }
        return client.readContract(args)
      },
    }
    const { checks } = await checkCurrencies({
      builder,
      chainId,
      client: failing,
      config: configStore,
      currencies: LIGHTER_MAINNET_CURRENCIES,
      decodePayload: decodePayload(store),
      depository,
      depositoryEncoded,
      expectDisabled: ["ETH Spot"],
      expectedLighterChainId: appChainId,
      log: () => undefined,
      sampleReceiver,
    })

    expect(failures(checks)).toEqual([
      {
        detail: "revert: ConfigValueNotSet (expected CurrencyDisabled)",
        label: "buildPayload(ETH Spot) reverts CurrencyDisabled",
        ok: false,
      },
    ])
  })
})
