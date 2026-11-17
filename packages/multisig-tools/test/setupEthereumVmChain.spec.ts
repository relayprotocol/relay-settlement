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
  buildSetupEthereumVmChainCalls,
  ethereumVmChainIdKey,
  type ReadClient,
} from "../scripts/generate-setup-ethereum-vm-chain"

const allocator = `0x${"a1".repeat(20)}` as Hex
const config = `0x${"c0".repeat(20)}` as Hex
const payloadBuilder = `0x${"b2".repeat(20)}` as Hex
const otherBuilder = `0x${"b3".repeat(20)}` as Hex
const depository = `0x${"d0".repeat(20)}` as Hex
const zeroAddress = `0x${"00".repeat(20)}` as Hex

const abi = parseAbi([
  "function setConfigValue(bytes32 key, bytes32 value)",
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

const clientWith = (state: {
  chainIdValue?: bigint
  builder: Hex
}): ReadClient => ({
  readContract: async ({ functionName }) => {
    if (functionName === "getConfigValue") {
      if (state.chainIdValue === undefined) throw configValueNotSet()
      return toHex(state.chainIdValue, { size: 32 })
    }
    if (functionName === "payloadBuilders") return state.builder
    throw new Error(`unexpected read ${functionName}`)
  },
})

const build = (client: ReadClient) =>
  buildSetupEthereumVmChainCalls({
    allocator,
    chainId: "megaeth",
    client,
    config,
    depository,
    evmChainId: 4326n,
    payloadBuilder,
  })

describe("buildSetupEthereumVmChainCalls", () => {
  it("emits the Config write before the builder registration", async () => {
    const calls = await build(clientWith({ builder: zeroAddress }))

    expect(calls.map((call) => call.to)).toEqual([config, allocator])
    expect(decodeFunctionData({ abi, data: calls[0].calldata }).args).toEqual([
      ethereumVmChainIdKey("megaeth"),
      toHex(4326n, { size: 32 }),
    ])
    expect(decodeFunctionData({ abi, data: calls[1].calldata }).args).toEqual([
      "megaeth",
      depository,
      getAddress(payloadBuilder),
    ])
  })

  it("skips calls whose state already matches", async () => {
    await expect(
      build(clientWith({ builder: payloadBuilder, chainIdValue: 4326n }))
    ).resolves.toEqual([])
  })

  it("refuses to overwrite a different EVM chain id", async () => {
    await expect(
      build(clientWith({ builder: zeroAddress, chainIdValue: 1n }))
    ).rejects.toThrow("already 1, expected 4326")
  })

  it("refuses to overwrite a different payload builder", async () => {
    await expect(
      build(clientWith({ builder: otherBuilder, chainIdValue: 4326n }))
    ).rejects.toThrow(`already ${otherBuilder}`)
  })
})
