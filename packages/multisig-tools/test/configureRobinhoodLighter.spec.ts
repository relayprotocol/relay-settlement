import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  toBytes,
  type Hex,
} from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BUILD_PAYLOAD_SELECTORS,
  buildPayloadAbisIn,
  buildRobinhoodLighterCalls,
  resolvePayloadBuilder,
  ROBINHOOD_LIGHTER_APP_CHAIN_ID,
  ROBINHOOD_LIGHTER_CHAIN_ID,
  ROBINHOOD_LIGHTER_DEPOSITORIES,
} from "../scripts/generate-configure-robinhood-lighter"

const allocator = `0x${"a1".repeat(20)}` as Hex
const config = `0x${"c0".repeat(20)}` as Hex
const payloadBuilder = `0x${"b2".repeat(20)}` as Hex
const lighterMainnetBuilder = `0x${"01".repeat(20)}` as Hex
const previousBuilder = `0x${"d4".repeat(20)}` as Hex
const zeroAddress = `0x${"00".repeat(20)}` as Hex
const depository = "28482"
// SDK lighter-vm encoding: 16-byte big-endian account index.
const depositoryEncoded = "0x00000000000000000000000000006f42"
const usdg = `0x${"00".repeat(16)}` as Hex

const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

// Deterministic stand-ins for the builder's pure key getters.
const keyFor = (fn: string, currency: Hex): Hex =>
  keccak256(toBytes(`${fn}:${ROBINHOOD_LIGHTER_CHAIN_ID}:${currency}`))

const instanceKeyFor = (fn: string): Hex =>
  keccak256(toBytes(`${fn}:${ROBINHOOD_LIGHTER_CHAIN_ID}`))

// The builder being replaced derives its keys differently.
const legacyKeyFor = (fn: string, currency: Hex): Hex =>
  keyFor(`legacy:${fn}`, currency)

const configValueNotSet = () => {
  const revert = new ContractFunctionRevertedError({
    abi: parseAbi(["error ConfigValueNotSet(bytes32 key)"]),
    data: `0x${"00".repeat(4)}` as Hex,
    functionName: "getConfigValue",
  })
  Object.assign(revert, { data: { errorName: "ConfigValueNotSet" } })
  return new BaseError("reverted", { cause: revert })
}

type BuildPayloadAbi = keyof typeof BUILD_PAYLOAD_SELECTORS

// Minimal stand-in for runtime code: some bytes around the dispatch selector.
const codeWith = (abi: BuildPayloadAbi): Hex =>
  `0x6080${BUILD_PAYLOAD_SELECTORS[abi].slice(2)}5b` as Hex

type State = {
  allocatorAbi: BuildPayloadAbi
  // config-driven builders expose the instance key getters instead of immutables
  configDriven: boolean
  builderAbi: BuildPayloadAbi
  builderConfig: Hex
  configValues: Record<string, Hex>
  fromAccountIndex: bigint
  lighterChainId: bigint
  registered: Hex
}

const makeClient = (state: State) => ({
  getCode: vi.fn(async ({ address }: { address: Hex }) => {
    if (address === allocator) return codeWith(state.allocatorAbi)
    if (address === payloadBuilder) return codeWith(state.builderAbi)
    throw new Error(`unexpected getCode on ${address}`)
  }),
  readContract: vi.fn(
    async ({
      address,
      args,
      functionName,
    }: {
      address: Hex
      args?: readonly unknown[]
      functionName: string
    }) => {
      if (address === payloadBuilder) {
        switch (functionName) {
          case "CONFIG":
            return state.builderConfig
          case "FROM_ACCOUNT_INDEX":
            if (state.configDriven) throw new Error("reverted")
            return state.fromAccountIndex
          case "LIGHTER_CHAIN_ID":
            if (state.configDriven) throw new Error("reverted")
            return state.lighterChainId
          case "getFromAccountIndexKey":
          case "getLighterChainIdKey":
            if (!state.configDriven) throw new Error("reverted")
            expect(args).toEqual([ROBINHOOD_LIGHTER_CHAIN_ID])
            return instanceKeyFor(functionName)
          default:
            return keyFor(functionName, args?.[1] as Hex)
        }
      }
      if (address === previousBuilder) {
        return legacyKeyFor(functionName, args?.[1] as Hex)
      }
      if (address === allocator && functionName === "payloadBuilders") {
        expect(args).toEqual([ROBINHOOD_LIGHTER_CHAIN_ID, depositoryEncoded])
        return state.registered
      }
      if (address === config && functionName === "getConfigValue") {
        const value = state.configValues[(args?.[0] as Hex).toLowerCase()]
        if (!value) throw configValueNotSet()
        return value
      }
      throw new Error(`unexpected read ${functionName} on ${address}`)
    }
  ),
})

const healthy = (): State => ({
  allocatorAbi: "legacy",
  builderAbi: "legacy",
  builderConfig: config,
  configDriven: false,
  configValues: {},
  fromAccountIndex: 28482n,
  lighterChainId: ROBINHOOD_LIGHTER_APP_CHAIN_ID,
  registered: zeroAddress,
})

describe("Robinhood Lighter payload builder manifest generator", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
  })

  it("records the dev depository account index from DEC-1927", () => {
    expect(ROBINHOOD_LIGHTER_DEPOSITORIES.dev).toBe(depository)
    expect(ROBINHOOD_LIGHTER_APP_CHAIN_ID).toBe(466324n)
    expect(ROBINHOOD_LIGHTER_CHAIN_ID).toBe("robinhood-lighter")
  })

  it("emits the USDG config write ahead of the registration on a fresh deployment", async () => {
    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient(healthy()),
      config,
      depository,
      migrationReviewed: true,
      payloadBuilder,
    })
    // Config first: the builder must be able to build before it is registered.
    expect(calls.map((c) => c.to)).toEqual([config, allocator])

    const registration = decodeFunctionData({
      abi: parseAbi([
        "function setPayloadBuilder(string chainId, bytes depository, address builder)",
      ]),
      data: calls[1].calldata,
    })
    expect(registration.args).toEqual([
      ROBINHOOD_LIGHTER_CHAIN_ID,
      depositoryEncoded,
      getAddress(payloadBuilder),
    ])

    const configWrite = decodeFunctionData({
      abi: parseAbi([
        "function setConfigValues(bytes32[] keys, bytes32[] values)",
      ]),
      data: calls[0].calldata,
    })
    expect(configWrite.args).toEqual([
      [
        keyFor("getFromRouteTypeKey", usdg),
        keyFor("getToRouteTypeKey", usdg),
        keyFor("getAssetIndexKey", usdg),
      ],
      [word(0n), word(0n), word(3n)],
    ])
  })

  it("skips the registration when the builder is already registered", async () => {
    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient({ ...healthy(), registered: payloadBuilder }),
      config,
      depository,
      migrationReviewed: true,
      payloadBuilder,
    })
    expect(calls.map((c) => c.to)).toEqual([config])
  })

  it("re-registers when the Lighter mainnet builder is still keyed under robinhood-lighter", async () => {
    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient({ ...healthy(), registered: lighterMainnetBuilder }),
      config,
      depository,
      migrationReviewed: true,
      payloadBuilder,
    })
    expect(calls.map((c) => c.to)).toEqual([config, allocator])
    expect(calls[1].label).toContain(`[was ${lighterMainnetBuilder}]`)
  })

  it("never rewrites a set Config value that drifted from the currency set", async () => {
    const state = healthy()
    state.registered = payloadBuilder
    state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getToRouteTypeKey", usdg)] = word(0n)
    // asset index differs from the set: reported, not rewritten
    state.configValues[keyFor("getAssetIndexKey", usdg)] = word(1n)

    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient(state),
      config,
      depository,
      payloadBuilder,
    })
    expect(calls).toEqual([])
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[keep\] USDG Perp: on-chain 0,0,1 differs from set default 0,0,3; not rewritten/
      )
    )
  })

  it("only writes the Config keys that are unset", async () => {
    const state = healthy()
    state.registered = payloadBuilder
    state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getAssetIndexKey", usdg)] = word(3n)

    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient(state),
      config,
      depository,
      payloadBuilder,
    })
    expect(calls).toHaveLength(1)
    const configWrite = decodeFunctionData({
      abi: parseAbi([
        "function setConfigValues(bytes32[] keys, bytes32[] values)",
      ]),
      data: calls[0].calldata,
    })
    expect(configWrite.args).toEqual([
      [keyFor("getToRouteTypeKey", usdg)],
      [word(0n)],
    ])
  })

  it("returns nothing when everything already matches", async () => {
    const state = healthy()
    state.registered = payloadBuilder
    state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getToRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getAssetIndexKey", usdg)] = word(3n)
    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(state),
        config,
        depository,
        payloadBuilder,
      })
    ).resolves.toEqual([])
  })

  it("refuses a builder that signs for Lighter mainnet (app-chain id 304)", async () => {
    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient({ ...healthy(), lighterChainId: 304n }),
        config,
        depository,
        payloadBuilder,
      })
    ).rejects.toThrow("app-chain id 304, expected 466324")
  })

  it("refuses a builder whose account index is not the recorded depository", async () => {
    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient({ ...healthy(), fromAccountIndex: 730948n }),
        config,
        depository,
        payloadBuilder,
      })
    ).rejects.toThrow(
      "withdraws from account 730948, expected depository 28482"
    )
  })

  it("refuses a builder wired to a different Config store", async () => {
    const otherConfig = `0x${"ee".repeat(20)}` as Hex
    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient({ ...healthy(), builderConfig: otherConfig }),
        config,
        depository,
        payloadBuilder,
      })
    ).rejects.toThrow(`CONFIG=${otherConfig}, expected ${config}`)
  })

  it("refuses a builder whose buildPayload ABI differs from the allocator's (#769)", async () => {
    const state = { ...healthy(), builderAbi: "requestHash" as const }
    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(state),
        config,
        depository,
        payloadBuilder,
      })
    ).rejects.toThrow(
      "exposes buildPayload(requestHash) but allocator 0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1 calls buildPayload(legacy)"
    )
  })

  it("accepts a builder and allocator that both use the requestHash ABI", async () => {
    const state = {
      ...healthy(),
      allocatorAbi: "requestHash" as const,
      builderAbi: "requestHash" as const,
    }
    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient(state),
      config,
      depository,
      migrationReviewed: true,
      payloadBuilder,
    })
    expect(calls.length).toBeGreaterThan(0)
  })

  it("recognises both buildPayload selectors in runtime code", () => {
    expect(buildPayloadAbisIn(codeWith("legacy"))).toEqual(["legacy"])
    expect(buildPayloadAbisIn(codeWith("requestHash"))).toEqual(["requestHash"])
    expect(buildPayloadAbisIn("0x6080")).toEqual([])
    expect(buildPayloadAbisIn(undefined)).toEqual([])
  })

  it("refuses a fresh deployment without a migration review", async () => {
    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(healthy()),
        config,
        depository,
        payloadBuilder,
      })
    ).rejects.toThrow(/PREVIOUS_PAYLOAD_BUILDER.*MIGRATION_REVIEWED=1/)
    // CONFIRM_DISABLE_ALL is not a substitute for the first-time review.
    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(healthy()),
        config,
        confirmDisableAll: true,
        depository,
        payloadBuilder,
      })
    ).rejects.toThrow(/PREVIOUS_PAYLOAD_BUILDER.*MIGRATION_REVIEWED=1/)
  })

  it("leaves a USDG asset index of zero alone while writing the rest", async () => {
    const state = healthy()
    state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getToRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getAssetIndexKey", usdg)] = word(0n)

    // Registration still goes out; only the disabled asset index is held back.
    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient(state),
      config,
      depository,
      payloadBuilder,
    })
    expect(calls.map((c) => c.to)).toEqual([allocator])
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/\[disabled\] USDG Perp assetIndex is 0/)
    )
  })

  it("sends nothing on a later run when the persisted zero is the only state", async () => {
    const state = healthy()
    state.registered = payloadBuilder
    state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getToRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getAssetIndexKey", usdg)] = word(0n)

    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(state),
        config,
        depository,
        payloadBuilder,
      })
    ).resolves.toEqual([])
  })

  it("refuses an unset USDG asset index whose route types are set without a previous builder", async () => {
    const state = healthy()
    state.registered = payloadBuilder
    state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getToRouteTypeKey", usdg)] = word(0n)

    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(state),
        config,
        depository,
        payloadBuilder,
      })
    ).rejects.toThrow(
      /USDG Perp assetIndex is unset under builder .* while its route-type keys are set.*Pass PREVIOUS_PAYLOAD_BUILDER or add "USDG Perp" to REENABLE_CURRENCIES/
    )
  })

  it("writes an unset USDG asset index whose route types are set when listed", async () => {
    const state = healthy()
    state.registered = payloadBuilder
    state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getToRouteTypeKey", usdg)] = word(0n)

    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient(state),
      config,
      depository,
      payloadBuilder,
      reenableCurrencies: ["USDG Perp"],
    })
    expect(calls).toHaveLength(1)
    const configWrite = decodeFunctionData({
      abi: parseAbi([
        "function setConfigValues(bytes32[] keys, bytes32[] values)",
      ]),
      data: calls[0].calldata,
    })
    expect(configWrite.args).toEqual([
      [keyFor("getAssetIndexKey", usdg)],
      [word(3n)],
    ])
  })

  it("rejects a REENABLE_CURRENCIES label outside the currency set", async () => {
    await expect(
      buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(healthy()),
        config,
        depository,
        migrationReviewed: true,
        payloadBuilder,
        reenableCurrencies: ["ETH Spot"],
      })
    ).rejects.toThrow(
      /REENABLE_CURRENCIES names no "robinhood-lighter" currency: "ETH Spot"/
    )
  })

  it("re-enables USDG only when listed in reenableCurrencies", async () => {
    const state = healthy()
    state.registered = payloadBuilder
    state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getToRouteTypeKey", usdg)] = word(0n)
    state.configValues[keyFor("getAssetIndexKey", usdg)] = word(0n)

    const calls = await buildRobinhoodLighterCalls({
      allocator,
      client: makeClient(state),
      config,
      depository,
      payloadBuilder,
      reenableCurrencies: ["USDG Perp"],
    })
    expect(calls).toHaveLength(1)
    const configWrite = decodeFunctionData({
      abi: parseAbi([
        "function setConfigValues(bytes32[] keys, bytes32[] values)",
      ]),
      data: calls[0].calldata,
    })
    expect(configWrite.args).toEqual([
      [keyFor("getAssetIndexKey", usdg)],
      [word(3n)],
    ])
  })

  describe("replacing a previous builder", () => {
    it("carries the USDG values over to the new keys without a migration review", async () => {
      const state = healthy()
      state.configValues[legacyKeyFor("getFromRouteTypeKey", usdg)] = word(0n)
      state.configValues[legacyKeyFor("getToRouteTypeKey", usdg)] = word(0n)
      state.configValues[legacyKeyFor("getAssetIndexKey", usdg)] = word(3n)

      const calls = await buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(state),
        config,
        depository,
        payloadBuilder,
        previousPayloadBuilder: previousBuilder,
      })
      expect(calls.map((c) => c.to)).toEqual([config, allocator])
      const configWrite = decodeFunctionData({
        abi: parseAbi([
          "function setConfigValues(bytes32[] keys, bytes32[] values)",
        ]),
        data: calls[0].calldata,
      })
      expect(configWrite.args).toEqual([
        [
          keyFor("getFromRouteTypeKey", usdg),
          keyFor("getToRouteTypeKey", usdg),
          keyFor("getAssetIndexKey", usdg),
        ],
        [word(0n), word(0n), word(3n)],
      ])
    })

    it("migrates non-default USDG legacy values exactly", async () => {
      const state = healthy()
      state.configValues[legacyKeyFor("getFromRouteTypeKey", usdg)] = word(1n)
      state.configValues[legacyKeyFor("getToRouteTypeKey", usdg)] = word(1n)
      state.configValues[legacyKeyFor("getAssetIndexKey", usdg)] = word(7n)

      const calls = await buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(state),
        config,
        depository,
        payloadBuilder,
        previousPayloadBuilder: previousBuilder,
      })
      const configWrite = decodeFunctionData({
        abi: parseAbi([
          "function setConfigValues(bytes32[] keys, bytes32[] values)",
        ]),
        data: calls[0].calldata,
      })
      expect(configWrite.args).toEqual([
        [
          keyFor("getFromRouteTypeKey", usdg),
          keyFor("getToRouteTypeKey", usdg),
          keyFor("getAssetIndexKey", usdg),
        ],
        [word(1n), word(1n), word(7n)],
      ])
      expect(console.log).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[migrate\] USDG Perp: carried 1,1,7 \(set default 0,0,3\)/
        )
      )

      // Apply run 1; run 2 with no env must not touch the carried values.
      const migrated = healthy()
      migrated.registered = payloadBuilder
      const [writtenKeys, writtenValues] = configWrite.args
      writtenKeys.forEach((k, i) => {
        migrated.configValues[k.toLowerCase()] = writtenValues[i]
      })
      await expect(
        buildRobinhoodLighterCalls({
          allocator,
          client: makeClient(migrated),
          config,
          depository,
          payloadBuilder,
        })
      ).resolves.toEqual([])
      expect(console.log).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[keep\] USDG Perp: on-chain 1,1,7 differs from set default 0,0,3/
        )
      )
    })

    it("keeps USDG disabled under the previous builder's key disabled", async () => {
      for (const legacy of [word(0n), undefined]) {
        const state = healthy()
        if (legacy) {
          state.configValues[legacyKeyFor("getAssetIndexKey", usdg)] = legacy
        }

        const calls = await buildRobinhoodLighterCalls({
          allocator,
          client: makeClient(state),
          config,
          // USDG is the only currency, so a disabled legacy value disables all.
          confirmDisableAll: true,
          depository,
          payloadBuilder,
          previousPayloadBuilder: previousBuilder,
        })
        // Route types move to the new keys; the asset index is persisted as 0.
        expect(calls.map((c) => c.to)).toEqual([config, allocator])
        const configWrite = decodeFunctionData({
          abi: parseAbi([
            "function setConfigValues(bytes32[] keys, bytes32[] values)",
          ]),
          data: calls[0].calldata,
        })
        expect(configWrite.args).toEqual([
          [
            keyFor("getFromRouteTypeKey", usdg),
            keyFor("getToRouteTypeKey", usdg),
            keyFor("getAssetIndexKey", usdg),
          ],
          [word(0n), word(0n), word(0n)],
        ])
        expect(console.log).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(
              `\\[disabled\\] USDG Perp assetIndex is ${legacy ? "0" : "unset"} under builder ${previousBuilder} .*writing 0`
            )
          )
        )
      }
    })

    it("rejects a previous builder equal to the target", async () => {
      await expect(
        buildRobinhoodLighterCalls({
          allocator,
          client: makeClient(healthy()),
          config,
          depository,
          payloadBuilder,
          previousPayloadBuilder: payloadBuilder,
        })
      ).rejects.toThrow(
        `PREVIOUS_PAYLOAD_BUILDER ${payloadBuilder} is the target builder`
      )
    })

    it("refuses a previous builder under which USDG is not enabled", async () => {
      await expect(
        buildRobinhoodLighterCalls({
          allocator,
          client: makeClient(healthy()),
          config,
          depository,
          payloadBuilder,
          previousPayloadBuilder: previousBuilder,
        })
      ).rejects.toThrow(
        /no "robinhood-lighter" currency has a non-zero asset index under previous builder .*looks like the wrong builder.*CONFIRM_DISABLE_ALL=1/
      )
      // MIGRATION_REVIEWED covers a first-time configuration only.
      await expect(
        buildRobinhoodLighterCalls({
          allocator,
          client: makeClient(healthy()),
          config,
          depository,
          migrationReviewed: true,
          payloadBuilder,
          previousPayloadBuilder: previousBuilder,
        })
      ).rejects.toThrow(/looks like the wrong builder/)
    })

    it("re-enables USDG under a previous builder only when listed", async () => {
      const state = healthy()
      state.configValues[legacyKeyFor("getAssetIndexKey", usdg)] = word(0n)

      const calls = await buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(state),
        config,
        depository,
        payloadBuilder,
        previousPayloadBuilder: previousBuilder,
        reenableCurrencies: ["USDG Perp"],
      })
      const configWrite = decodeFunctionData({
        abi: parseAbi([
          "function setConfigValues(bytes32[] keys, bytes32[] values)",
        ]),
        data: calls[0].calldata,
      })
      expect(configWrite.args[0]).toContain(keyFor("getAssetIndexKey", usdg))
      expect(configWrite.args[1][2]).toBe(word(3n))
    })
  })

  describe("with a config-driven (shared) builder", () => {
    const shared = (): State => ({
      ...healthy(),
      configDriven: true,
      // a shared builder carries no immutables; these must be ignored
      fromAccountIndex: 0n,
      lighterChainId: 0n,
    })

    it("writes the account index and app-chain id ahead of the USDG values", async () => {
      const calls = await buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(shared()),
        config,
        depository,
        migrationReviewed: true,
        payloadBuilder,
      })
      expect(calls.map((c) => c.to)).toEqual([config, allocator])
      const configWrite = decodeFunctionData({
        abi: parseAbi([
          "function setConfigValues(bytes32[] keys, bytes32[] values)",
        ]),
        data: calls[0].calldata,
      })
      expect(configWrite.args).toEqual([
        [
          instanceKeyFor("getFromAccountIndexKey"),
          instanceKeyFor("getLighterChainIdKey"),
          keyFor("getFromRouteTypeKey", usdg),
          keyFor("getToRouteTypeKey", usdg),
          keyFor("getAssetIndexKey", usdg),
        ],
        [word(28482n), word(466324n), word(0n), word(0n), word(3n)],
      ])
    })

    it("overwrites an account index or app-chain id that differs", async () => {
      const state = shared()
      state.registered = payloadBuilder
      state.configValues[instanceKeyFor("getFromAccountIndexKey")] =
        word(28482n)
      // still points at Lighter mainnet's app-chain id
      state.configValues[instanceKeyFor("getLighterChainIdKey")] = word(304n)
      state.configValues[keyFor("getFromRouteTypeKey", usdg)] = word(0n)
      state.configValues[keyFor("getToRouteTypeKey", usdg)] = word(0n)
      state.configValues[keyFor("getAssetIndexKey", usdg)] = word(3n)

      const calls = await buildRobinhoodLighterCalls({
        allocator,
        client: makeClient(state),
        config,
        depository,
        payloadBuilder,
      })
      expect(calls).toHaveLength(1)
      const configWrite = decodeFunctionData({
        abi: parseAbi([
          "function setConfigValues(bytes32[] keys, bytes32[] values)",
        ]),
        data: calls[0].calldata,
      })
      expect(configWrite.args).toEqual([
        [instanceKeyFor("getLighterChainIdKey")],
        [word(466324n)],
      ])
    })

    it("still refuses a builder wired to a different Config store", async () => {
      const otherConfig = `0x${"ee".repeat(20)}` as Hex
      await expect(
        buildRobinhoodLighterCalls({
          allocator,
          client: makeClient({ ...shared(), builderConfig: otherConfig }),
          config,
          depository,
          payloadBuilder,
        })
      ).rejects.toThrow(`CONFIG=${otherConfig}, expected ${config}`)
    })
  })

  describe("default payload builder", () => {
    const payloadBuilders = {
      lighterVmPayloadBuilder: payloadBuilder,
      robinhoodLighterVmPayloadBuilder: lighterMainnetBuilder,
    }

    it("prefers the shared builder over a recorded legacy Robinhood builder", () => {
      expect(resolvePayloadBuilder(payloadBuilders)).toBe(payloadBuilder)
    })

    it("uses an explicit override, including the legacy builder", () => {
      expect(
        resolvePayloadBuilder(payloadBuilders, lighterMainnetBuilder)
      ).toBe(lighterMainnetBuilder)
    })

    it("returns nothing when no shared builder is recorded", () => {
      expect(
        resolvePayloadBuilder({
          robinhoodLighterVmPayloadBuilder: lighterMainnetBuilder,
        })
      ).toBeUndefined()
    })
  })
})
