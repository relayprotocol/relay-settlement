import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  getAddress,
  parseAbi,
  toHex,
  type Hex,
} from "viem"
import { describe, expect, it } from "vitest"

import {
  ATLAS_INSTANCES,
  buildConfigureAtlasVmCalls,
  type ReadClient,
} from "../scripts/generate-configure-atlas-vm"
import { BUILD_PAYLOAD_SELECTORS } from "../scripts/generate-configure-robinhood-lighter"

const allocator = `0x${"a1".repeat(20)}` as Hex
const config = `0x${"c0".repeat(20)}` as Hex
const otherConfig = `0x${"c1".repeat(20)}` as Hex
const payloadBuilder = `0x${"b2".repeat(20)}` as Hex
const otherBuilder = `0x${"b3".repeat(20)}` as Hex
const zeroAddress = `0x${"00".repeat(20)}` as Hex
const instance = ATLAS_INSTANCES.test!

const domainKey = `0x${"01".repeat(32)}` as Hex
const saltKey = `0x${"02".repeat(32)}` as Hex
const decimalsKey = `0x${"03".repeat(32)}` as Hex
const expirationKey = `0x${"04".repeat(32)}` as Hex

const abi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

const configValueNotSet = () => {
  const revert = new ContractFunctionRevertedError({
    abi: parseAbi(["error ConfigValueNotSet(bytes32 key)"]),
    data: `0x${"00".repeat(4)}` as Hex,
    functionName: "getConfigValue",
  })
  Object.assign(revert, { data: { errorName: "ConfigValueNotSet" } })
  return new BaseError("reverted", { cause: revert })
}

// Runtime code that embeds one buildPayload selector, as the deployed contracts do
const codeWith = (selector: Hex): Hex => `0x6080${selector.slice(2)}00`

const clientWith = (state: {
  allocatorCode?: Hex
  builder: Hex
  builderCode?: Hex
  builderConfig?: Hex
  values?: Record<Hex, bigint>
}): ReadClient => ({
  getCode: async ({ address }) =>
    address === allocator
      ? (state.allocatorCode ?? codeWith(BUILD_PAYLOAD_SELECTORS.legacy))
      : (state.builderCode ?? codeWith(BUILD_PAYLOAD_SELECTORS.legacy)),
  readContract: async ({ args, functionName }) => {
    if (functionName === "CONFIG") return state.builderConfig ?? config
    if (functionName === "getDomainChainIdKey") return domainKey
    if (functionName === "getDomainSaltKey") return saltKey
    if (functionName === "getExpirationKey") return expirationKey
    if (functionName === "getAssetDecimalsKey") return decimalsKey
    if (functionName === "getConfigValue") {
      const value = state.values?.[args![0] as Hex]
      if (value === undefined) throw configValueNotSet()
      return toHex(value, { size: 32 })
    }
    if (functionName === "payloadBuilders") return state.builder
    throw new Error(`unexpected read ${functionName}`)
  },
})

const build = (
  client: ReadClient,
  assetDecimals = new Map([[2, 6]]),
  atlasInstance = instance
) =>
  buildConfigureAtlasVmCalls({
    allocator,
    assetDecimals,
    client,
    config,
    instance: atlasInstance,
    payloadBuilder,
  })

describe("buildConfigureAtlasVmCalls", () => {
  it("emits the Config write before the builder registration", async () => {
    const calls = await build(clientWith({ builder: zeroAddress }))

    expect(calls.map((call) => call.to)).toEqual([config, allocator])
    expect(decodeFunctionData({ abi, data: calls[0].calldata }).args).toEqual([
      [domainKey, saltKey, expirationKey, decimalsKey],
      [
        toHex(43003n, { size: 32 }),
        instance.domainSalt,
        toHex(3600n, { size: 32 }),
        toHex(6n, { size: 32 }),
      ],
    ])
    expect(decodeFunctionData({ abi, data: calls[1].calldata }).args).toEqual([
      "atlas-testnet",
      instance.depository.toLowerCase(),
      getAddress(payloadBuilder),
    ])
  })

  it("writes only the Config keys that are still unset", async () => {
    const calls = await build(
      clientWith({
        builder: zeroAddress,
        values: { [domainKey]: 43003n, [saltKey]: BigInt(instance.domainSalt) },
      })
    )

    expect(decodeFunctionData({ abi, data: calls[0].calldata }).args).toEqual([
      [expirationKey, decimalsKey],
      [toHex(3600n, { size: 32 }), toHex(6n, { size: 32 })],
    ])
  })

  it("replaces the domain chain id the instance names", async () => {
    const calls = await build(
      clientWith({
        builder: payloadBuilder,
        values: {
          [decimalsKey]: 6n,
          [domainKey]: 21337n,
          [expirationKey]: 3600n,
          [saltKey]: BigInt(instance.domainSalt),
        },
      })
    )

    expect(calls.map((call) => call.to)).toEqual([config])
    expect(calls[0].label).toContain("(replacing 21337) = 43003")
    expect(decodeFunctionData({ abi, data: calls[0].calldata }).args).toEqual([
      [domainKey],
      [toHex(43003n, { size: 32 })],
    ])
  })

  it("skips calls whose state already matches", async () => {
    await expect(
      build(
        clientWith({
          builder: payloadBuilder,
          values: {
            [decimalsKey]: 6n,
            [domainKey]: 43003n,
            [expirationKey]: 3600n,
            [saltKey]: BigInt(instance.domainSalt),
          },
        })
      )
    ).resolves.toEqual([])
  })

  it("refuses to overwrite a different domain chain id", async () => {
    await expect(
      build(clientWith({ builder: zeroAddress, values: { [domainKey]: 1n } }))
    ).rejects.toThrow("already 1, expected 43003")
  })

  it("refuses to overwrite a different payload builder", async () => {
    await expect(build(clientWith({ builder: otherBuilder }))).rejects.toThrow(
      `already ${otherBuilder}`
    )
  })

  it("replaces the registered builder the instance names", async () => {
    const calls = await build(
      clientWith({ builder: otherBuilder }),
      undefined,
      {
        ...instance,
        replacesBuilder: otherBuilder,
      }
    )
    const registration = calls[calls.length - 1]

    expect(registration.to).toBe(allocator)
    expect(registration.label).toContain(`replacing ${otherBuilder}`)
    expect(
      decodeFunctionData({ abi, data: registration.calldata }).args
    ).toEqual([
      "atlas-testnet",
      instance.depository.toLowerCase(),
      getAddress(payloadBuilder),
    ])
  })

  it("still refuses a registered builder it does not name", async () => {
    await expect(
      build(clientWith({ builder: otherBuilder }), undefined, {
        ...instance,
        replacesBuilder: `0x${"b4".repeat(20)}`,
      })
    ).rejects.toThrow(`already ${otherBuilder}`)
  })

  it("refuses a builder that reads another Config", async () => {
    await expect(
      build(clientWith({ builder: zeroAddress, builderConfig: otherConfig }))
    ).rejects.toThrow(`reads Config ${otherConfig}`)
  })

  it("refuses a builder compiled for another allocator ABI", async () => {
    await expect(
      build(
        clientWith({
          allocatorCode: codeWith(BUILD_PAYLOAD_SELECTORS.requestHash),
          builder: zeroAddress,
        })
      )
    ).rejects.toThrow("but allocator")
  })

  it("refuses an address with no builder code", async () => {
    await expect(
      build(clientWith({ builder: zeroAddress, builderCode: "0x" }))
    ).rejects.toThrow(`No code at payload builder ${payloadBuilder}`)
  })

  it("refuses decimals Atlas does not report", async () => {
    await expect(
      build(clientWith({ builder: zeroAddress }), new Map([[2, 8]]))
    ).rejects.toThrow("Atlas reports 8 decimals for USDT, expected 6")
  })
})
