import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  toBytes,
  type Hex,
} from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildLighterConfigCall,
  readLighterCurrencyKeys,
  type LighterConfigOptions,
  type ReadClient,
} from "../scripts/generate-configure-bitcoin-hyperliquid-lighter"

const builder = `0x${"b2".repeat(20)}` as Hex
const previousBuilder = `0x${"c3".repeat(20)}` as Hex
// Prod Config store the generator writes to.
const config = "0x8162BeeC776442afd262B672730Bb5d0d8af16A1" as Hex

const LABELS: Record<string, string> = {
  getAssetIndexKey: "LIGHTER_VM_ASSET_INDEX",
  getFromRouteTypeKey: "LIGHTER_VM_FROM_ROUTE_TYPE",
  getToRouteTypeKey: "LIGHTER_VM_TO_ROUTE_TYPE",
}

const INSTANCE_LABELS: Record<string, string> = {
  getFromAccountIndexKey: "LIGHTER_VM_FROM_ACCOUNT_INDEX",
  getLighterChainIdKey: "LIGHTER_VM_CHAIN_ID",
}

const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

// Current LighterVmPayloadBuilder derivation: the chain id is hashed first.
const hashedChainIdKey = (fn: string, chainId: string, currency: Hex): Hex =>
  keccak256(
    encodePacked(
      ["bytes32", "bytes32", "bytes"],
      [keccak256(toBytes(LABELS[fn])), keccak256(toBytes(chainId)), currency]
    )
  )

// Legacy derivation of the builder deployed before the redeploy.
const packedChainIdKey = (fn: string, chainId: string, currency: Hex): Hex =>
  keccak256(
    encodePacked(
      ["bytes32", "string", "bytes"],
      [keccak256(toBytes(LABELS[fn])), chainId, currency]
    )
  )

const instanceKey = (fn: string, chainId: string): Hex =>
  keccak256(
    encodePacked(
      ["bytes32", "bytes32"],
      [keccak256(toBytes(INSTANCE_LABELS[fn])), keccak256(toBytes(chainId))]
    )
  )

type KeyFor = (_fn: string, _chainId: string, _currency: Hex) => Hex

const configValueNotSet = () => {
  const revert = new ContractFunctionRevertedError({
    abi: parseAbi(["error ConfigValueNotSet(bytes32 key)"]),
    data: `0x${"00".repeat(4)}` as Hex,
    functionName: "getConfigValue",
  })
  Object.assign(revert, { data: { errorName: "ConfigValueNotSet" } })
  return new BaseError("reverted", { cause: revert })
}

// Builders keyed by address (each with its own derivation) over one Config store.
const makeClient = (
  builders: Record<string, KeyFor>,
  store: Record<string, Hex> = {}
): ReadClient => ({
  readContract: async ({ address, functionName, args }) => {
    if (address === config && functionName === "getConfigValue") {
      const value = store[(args![0] as Hex).toLowerCase()]
      if (!value) throw configValueNotSet()
      return value
    }
    const keyFor = builders[address]
    if (!keyFor) throw new Error(`unexpected read on ${address}`)
    if (functionName in INSTANCE_LABELS) {
      return instanceKey(functionName, args![0] as string)
    }
    if (!(functionName in LABELS)) throw new Error("unexpected read")
    return keyFor(functionName, args![0] as string, args![1] as Hex)
  },
})

const decodeWrite = (
  calldata: Hex
): { keys: readonly Hex[]; values: readonly Hex[] } => {
  const { args } = decodeFunctionData({
    abi: parseAbi([
      "function setConfigValues(bytes32[] keys, bytes32[] values)",
    ]),
    data: calldata,
  })
  return { keys: args[0], values: args[1] }
}

const CURRENCIES: Hex[] = [
  `0x${"00".repeat(16)}`,
  "0x00000000000000000000000000000001",
  "0x00000000000000000000000000000003",
]
const KEY_GETTERS = [
  "getFromRouteTypeKey",
  "getToRouteTypeKey",
  "getAssetIndexKey",
]
const ethSpot = CURRENCIES[1]
const usdcSpot = CURRENCIES[2]
const ethSpotAssetKey = hashedChainIdKey("getAssetIndexKey", "lighter", ethSpot)
const ethSpotLegacyAssetKey = packedChainIdKey(
  "getAssetIndexKey",
  "lighter",
  ethSpot
)

// Config store holding the currency set as the generator would write it.
const configured = (keyFor: KeyFor): Record<string, Hex> => {
  const store: Record<string, Hex> = {}
  const routes = [0n, 1n, 1n]
  const assets = [3n, 1n, 3n]
  CURRENCIES.forEach((currency, i) => {
    store[keyFor("getFromRouteTypeKey", "lighter", currency)] = word(routes[i])
    store[keyFor("getToRouteTypeKey", "lighter", currency)] = word(routes[i])
    store[keyFor("getAssetIndexKey", "lighter", currency)] = word(assets[i])
  })
  return store
}

const legacyInstance = { accountIndex: 730948n }

const call = (
  client: ReadClient,
  options: LighterConfigOptions = {},
  lighter = legacyInstance
) => buildLighterConfigCall(client, lighter, options, builder)

const current = { [builder]: hashedChainIdKey }

describe("Lighter currency config keys", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("writes the keys the target builder derives", async () => {
    const result = await call(makeClient(current), { migrationReviewed: true })

    const expected = CURRENCIES.flatMap((currency) =>
      KEY_GETTERS.map((fn) => hashedChainIdKey(fn, "lighter", currency))
    )
    expect(decodeWrite(result!.calldata).keys).toEqual(expected)
    expect(result!.to).toBe(config)
  })

  it("follows a legacy builder's derivation", async () => {
    const result = await call(makeClient({ [builder]: packedChainIdKey }), {
      migrationReviewed: true,
    })
    expect(decodeWrite(result!.calldata).keys[0]).toEqual(
      packedChainIdKey("getFromRouteTypeKey", "lighter", CURRENCIES[0])
    )
  })

  it("seeds the account index and app-chain id for a config-driven builder", async () => {
    const result = await call(
      makeClient(current),
      { migrationReviewed: true },
      {
        accountIndex: 730948n,
        lighterChainIdKey: instanceKey("getLighterChainIdKey", "lighter"),
      }
    )
    const { keys, values } = decodeWrite(result!.calldata)
    expect(keys.slice(0, 2)).toEqual([
      instanceKey("getFromAccountIndexKey", "lighter"),
      instanceKey("getLighterChainIdKey", "lighter"),
    ])
    expect(values.slice(0, 2)).toEqual([word(730948n), word(304n)])
    expect(keys).toHaveLength(11)
  })

  it("refuses a builder without the key getters", async () => {
    const client: ReadClient = {
      readContract: async () => {
        throw new Error("execution reverted")
      },
    }
    await expect(readLighterCurrencyKeys(client, builder)).rejects.toThrow(
      /has no getFromRouteTypeKey\(string,bytes\)/
    )
    await expect(call(client)).rejects.toThrow(
      /has no getFromRouteTypeKey\(string,bytes\)/
    )
  })

  it("refuses a builder whose currency keys are all unset without a previous builder", async () => {
    await expect(call(makeClient(current))).rejects.toThrow(
      /PREVIOUS_PAYLOAD_BUILDER.*MIGRATION_REVIEWED=1/
    )
    // CONFIRM_DISABLE_ALL is not a substitute for the first-time review.
    await expect(
      call(makeClient(current), { confirmDisableAll: true })
    ).rejects.toThrow(/PREVIOUS_PAYLOAD_BUILDER.*MIGRATION_REVIEWED=1/)
  })

  it("emits no call when Config already holds every value", async () => {
    const client = makeClient(current, configured(hashedChainIdKey))
    await expect(call(client)).resolves.toBeUndefined()
  })

  it("never rewrites a set key that drifted from the currency set", async () => {
    const store = configured(hashedChainIdKey)
    store[ethSpotAssetKey] = word(9n)
    await expect(call(makeClient(current, store))).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[keep\] ETH Spot: on-chain 1,1,9 differs from set default 1,1,1; not rewritten/
      )
    )
  })

  it("writes only the keys that are unset", async () => {
    const store = configured(hashedChainIdKey)
    delete store[hashedChainIdKey("getToRouteTypeKey", "lighter", ethSpot)]
    const result = await call(makeClient(current, store))

    expect(decodeWrite(result!.calldata)).toEqual({
      keys: [hashedChainIdKey("getToRouteTypeKey", "lighter", ethSpot)],
      values: [word(1n)],
    })
  })

  it("never writes a non-zero asset index for ETH Spot while it is disabled on chain", async () => {
    const store = configured(hashedChainIdKey)
    store[ethSpotAssetKey] = word(0n)
    const usdcSpotToRouteKey = hashedChainIdKey(
      "getToRouteTypeKey",
      "lighter",
      usdcSpot
    )
    delete store[usdcSpotToRouteKey]
    const result = await call(makeClient(current, store))

    // Only the unset USDC Spot route is written; ETH Spot stays at 0.
    expect(decodeWrite(result!.calldata)).toEqual({
      keys: [usdcSpotToRouteKey],
      values: [word(1n)],
    })
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[disabled\] ETH Spot assetIndex is 0 .*leaving it at 0/
      )
    )
  })

  it("emits no call on a later run when the persisted zero is the only difference", async () => {
    const store = configured(hashedChainIdKey)
    store[ethSpotAssetKey] = word(0n)
    await expect(call(makeClient(current, store))).resolves.toBeUndefined()
  })

  it("re-enables ETH Spot only when listed in REENABLE_CURRENCIES", async () => {
    const store = configured(hashedChainIdKey)
    store[ethSpotAssetKey] = word(0n)

    const result = await call(makeClient(current, store), {
      reenableCurrencies: ["ETH Spot"],
    })
    expect(decodeWrite(result!.calldata)).toEqual({
      keys: [ethSpotAssetKey],
      values: [word(1n)],
    })
  })

  it("rejects a REENABLE_CURRENCIES label outside the currency set", async () => {
    await expect(
      call(makeClient(current, configured(hashedChainIdKey)), {
        reenableCurrencies: ["USDG Perp"],
      })
    ).rejects.toThrow(
      /REENABLE_CURRENCIES names no "lighter" currency: "USDG Perp"/
    )
  })

  it("refuses an unset ETH Spot asset index whose route types are set without a previous builder", async () => {
    const store = configured(hashedChainIdKey)
    delete store[ethSpotAssetKey]

    await expect(call(makeClient(current, store))).rejects.toThrow(
      /ETH Spot assetIndex is unset under builder .* while its route-type keys are set.*Pass PREVIOUS_PAYLOAD_BUILDER or add "ETH Spot" to REENABLE_CURRENCIES/
    )
  })

  it("writes an unset ETH Spot asset index whose route types are set when listed", async () => {
    const store = configured(hashedChainIdKey)
    delete store[ethSpotAssetKey]

    const result = await call(makeClient(current, store), {
      reenableCurrencies: ["ETH Spot"],
    })
    expect(decodeWrite(result!.calldata)).toEqual({
      keys: [ethSpotAssetKey],
      values: [word(1n)],
    })
  })

  it("writes a fresh currency whose three keys are all unset", async () => {
    const store = configured(hashedChainIdKey)
    for (const fn of KEY_GETTERS) {
      delete store[hashedChainIdKey(fn, "lighter", ethSpot)]
    }

    const result = await call(makeClient(current, store))
    expect(decodeWrite(result!.calldata)).toEqual({
      keys: KEY_GETTERS.map((fn) => hashedChainIdKey(fn, "lighter", ethSpot)),
      values: [word(1n), word(1n), word(1n)],
    })
  })

  describe("replacing a legacy-derivation builder", () => {
    const builders = {
      [builder]: hashedChainIdKey,
      [previousBuilder]: packedChainIdKey,
    }

    it("rejects a previous builder equal to the target", async () => {
      await expect(
        call(makeClient(builders), { previousPayloadBuilder: builder })
      ).rejects.toThrow(
        `PREVIOUS_PAYLOAD_BUILDER ${builder} is the target builder`
      )
    })

    it("refuses a previous builder under which no currency is enabled", async () => {
      await expect(
        call(makeClient(builders), { previousPayloadBuilder: previousBuilder })
      ).rejects.toThrow(
        /no "lighter" currency has a non-zero asset index under previous builder .*looks like the wrong builder/
      )
    })

    it("does not let MIGRATION_REVIEWED alone disable every currency", async () => {
      await expect(
        call(makeClient(builders), {
          migrationReviewed: true,
          previousPayloadBuilder: previousBuilder,
        })
      ).rejects.toThrow(/looks like the wrong builder.*CONFIRM_DISABLE_ALL=1/)
    })

    it("disables every currency under a previous builder with none enabled only with CONFIRM_DISABLE_ALL", async () => {
      const result = await call(makeClient(builders), {
        confirmDisableAll: true,
        previousPayloadBuilder: previousBuilder,
      })
      const { keys, values } = decodeWrite(result!.calldata)
      expect(keys).toHaveLength(9)
      for (const currency of CURRENCIES) {
        expect(
          values[
            keys.indexOf(
              hashedChainIdKey("getAssetIndexKey", "lighter", currency)
            )
          ]
        ).toBe(word(0n))
      }
    })

    it("keeps the per-currency behaviour when one currency is enabled under the legacy keys", async () => {
      const store = {
        [packedChainIdKey("getAssetIndexKey", "lighter", CURRENCIES[0])]:
          word(3n),
      }
      const result = await call(makeClient(builders, store), {
        previousPayloadBuilder: previousBuilder,
      })
      const { keys, values } = decodeWrite(result!.calldata)
      expect(keys).toHaveLength(9)
      expect(
        values[
          keys.indexOf(
            hashedChainIdKey("getAssetIndexKey", "lighter", CURRENCIES[0])
          )
        ]
      ).toBe(word(3n))
      expect(values[keys.indexOf(ethSpotAssetKey)]).toBe(word(0n))
    })

    it("carries the currency set over to the new keys", async () => {
      const result = await call(
        makeClient(builders, configured(packedChainIdKey)),
        { previousPayloadBuilder: previousBuilder }
      )
      const { keys, values } = decodeWrite(result!.calldata)
      expect(keys).toHaveLength(9)
      expect(values[keys.indexOf(ethSpotAssetKey)]).toBe(word(1n))
    })

    it("migrates legacy route types and asset index exactly, not the set defaults", async () => {
      const store = configured(packedChainIdKey)
      store[packedChainIdKey("getFromRouteTypeKey", "lighter", ethSpot)] =
        word(2n)
      store[packedChainIdKey("getToRouteTypeKey", "lighter", ethSpot)] =
        word(2n)
      store[ethSpotLegacyAssetKey] = word(7n)

      const result = await call(makeClient(builders, store), {
        previousPayloadBuilder: previousBuilder,
      })
      const { keys, values } = decodeWrite(result!.calldata)
      expect(
        values[
          keys.indexOf(
            hashedChainIdKey("getFromRouteTypeKey", "lighter", ethSpot)
          )
        ]
      ).toBe(word(2n))
      expect(
        values[
          keys.indexOf(
            hashedChainIdKey("getToRouteTypeKey", "lighter", ethSpot)
          )
        ]
      ).toBe(word(2n))
      expect(values[keys.indexOf(ethSpotAssetKey)]).toBe(word(7n))
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[migrate\] ETH Spot: carried 2,2,7 \(set default 1,1,1\)/
        )
      )

      // Apply run 1; run 2 with no env must not touch the carried values.
      const migrated: Record<string, Hex> = { ...store }
      keys.forEach((k, i) => {
        migrated[k.toLowerCase()] = values[i]
      })
      await expect(call(makeClient(current, migrated))).resolves.toBeUndefined()
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[keep\] ETH Spot: on-chain 2,2,7 differs from set default 1,1,1/
        )
      )
    })

    it("refuses a previous builder with none of the consulted currencies enabled on a partially set target", async () => {
      const store = {
        [hashedChainIdKey("getAssetIndexKey", "lighter", CURRENCIES[0])]:
          word(3n),
      }
      await expect(
        call(makeClient(builders, store), {
          previousPayloadBuilder: previousBuilder,
        })
      ).rejects.toThrow(
        /looks like the wrong builder \(checked: "ETH Spot", "USDC Spot"\).*CONFIRM_DISABLE_ALL=1/
      )
    })

    for (const [state, legacy] of [
      ["disabled", word(0n)],
      ["never configured", undefined],
    ] as const) {
      it(`persists zero for a currency ${state} under the legacy key`, async () => {
        const store = configured(packedChainIdKey)
        if (legacy) store[ethSpotLegacyAssetKey] = legacy
        else delete store[ethSpotLegacyAssetKey]

        const result = await call(makeClient(builders, store), {
          previousPayloadBuilder: previousBuilder,
        })
        const { keys, values } = decodeWrite(result!.calldata)
        expect(keys).toHaveLength(9)
        expect(values[keys.indexOf(ethSpotAssetKey)]).toBe(word(0n))
        expect(console.error).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(
              `\\[disabled\\] ETH Spot assetIndex is ${legacy ? "0" : "unset"} under builder ${previousBuilder} .*writing 0`
            )
          )
        )
      })

      it(`re-enables a currency ${state} under the legacy key when listed`, async () => {
        const store = configured(packedChainIdKey)
        if (legacy) store[ethSpotLegacyAssetKey] = legacy
        else delete store[ethSpotLegacyAssetKey]

        const result = await call(makeClient(builders, store), {
          previousPayloadBuilder: previousBuilder,
          reenableCurrencies: ["ETH Spot"],
        })
        const { keys, values } = decodeWrite(result!.calldata)
        expect(keys).toHaveLength(9)
        expect(values[keys.indexOf(ethSpotAssetKey)]).toBe(word(1n))
      })
    }
  })
})
