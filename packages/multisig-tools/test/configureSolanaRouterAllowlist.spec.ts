import {
  BaseError,
  ContractFunctionRevertedError,
  bytesToHex,
  decodeFunctionData,
  parseAbi,
  toHex,
  type Hex,
} from "viem"
import { describe, expect, it } from "vitest"
import { encodeAddress } from "@relay-protocol/settlement-sdk"

import {
  buildSolanaRouterAllowlistCalls,
  resolveTuples,
  type ReadClient,
} from "../scripts/generate-configure-solana-router-allowlist"

const allocator = `0x${"a1".repeat(20)}` as Hex
const config = `0x${"c0".repeat(20)}` as Hex
const payloadBuilder = `0x${"b2".repeat(20)}` as Hex
const oldBuilder = `0x${"b3".repeat(20)}` as Hex
const depository = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2"
const router = "9QybjuydfDYwJkdDLMJJaHEcQPaYeRoiJ5cYj7qLd5Su"
const routerKey = `0x${"01".repeat(32)}` as Hex

const abi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
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
  builder: Hex
  routed?: boolean
  value?: bigint
  keyArgs?: unknown[][]
}): ReadClient => ({
  readContract: async ({ address, args, functionName }) => {
    if (functionName === "payloadBuilders") {
      expect(address).toBe(allocator)
      return state.builder
    }
    if (functionName === "getRouterAllowedKey") {
      expect(address).toBe(payloadBuilder)
      if (state.routed === false) throw new Error("execution reverted")
      state.keyArgs?.push([...args!])
      return routerKey
    }
    if (functionName === "getConfigValue") {
      expect(args).toEqual([routerKey])
      if (state.value === undefined) throw configValueNotSet()
      return toHex(state.value, { size: 32 })
    }
    throw new Error(`unexpected read ${functionName}`)
  },
})

const build = (client: ReadClient, value = 1n) =>
  buildSolanaRouterAllowlistCalls({
    allocator,
    client,
    config,
    payloadBuilder,
    router,
    tuples: [{ chain: "solana", depository }],
    value,
  })

describe("buildSolanaRouterAllowlistCalls", () => {
  it("allowlists the router under the key the builder derives", async () => {
    const keyArgs: unknown[][] = []
    const calls = await build(clientWith({ builder: payloadBuilder, keyArgs }))

    expect(keyArgs).toEqual([
      [
        "solana",
        bytesToHex(encodeAddress(depository, "solana-vm")),
        bytesToHex(encodeAddress(router, "solana-vm")),
      ],
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toBe(config)
    expect(decodeFunctionData({ abi, data: calls[0].calldata }).args).toEqual([
      [routerKey],
      [toHex(1n, { size: 32 })],
    ])
  })

  it("skips a key already at the requested value", async () => {
    await expect(
      build(clientWith({ builder: payloadBuilder, value: 1n }))
    ).resolves.toEqual([])
  })

  it("refuses to allow behind another registered builder", async () => {
    await expect(build(clientWith({ builder: oldBuilder }))).rejects.toThrow(
      /registered builder is/
    )
  })

  it("registers the builder first when asked, then allowlists", async () => {
    const calls = await buildSolanaRouterAllowlistCalls({
      allocator,
      client: clientWith({ builder: oldBuilder }),
      config,
      payloadBuilder,
      registerBuilder: true,
      router,
      tuples: [{ chain: "solana", depository }],
      value: 1n,
    })
    expect(calls.map((call) => call.to)).toEqual([allocator, config])
    const [chain, encodedDepository, builder] = decodeFunctionData({
      abi: parseAbi([
        "function setPayloadBuilder(string chainId, bytes depository, address payloadBuilder)",
      ]),
      data: calls[0].calldata,
    }).args
    expect([chain, encodedDepository, builder.toLowerCase()]).toEqual([
      "solana",
      bytesToHex(encodeAddress(depository, "solana-vm")),
      payloadBuilder,
    ])
  })

  it("only registers when allowing", async () => {
    await expect(
      buildSolanaRouterAllowlistCalls({
        allocator,
        client: clientWith({ builder: oldBuilder }),
        config,
        payloadBuilder,
        registerBuilder: true,
        router,
        tuples: [{ chain: "solana", depository }],
        value: 0n,
      })
    ).rejects.toThrow(/only applies when allowing/)
  })

  it("refuses a builder without routed mode", async () => {
    await expect(
      build(clientWith({ builder: payloadBuilder, routed: false }))
    ).rejects.toThrow(/not a routed-capable SolanaVmPayloadBuilder/)
  })

  it("revokes with any other value without the builder check", async () => {
    const calls = await build(
      clientWith({ builder: oldBuilder, value: 1n }),
      0n
    )

    expect(decodeFunctionData({ abi, data: calls[0].calldata }).args).toEqual([
      [routerKey],
      [toHex(0n, { size: 32 })],
    ])
  })

  it("rejects a router that is not a Solana address", async () => {
    await expect(
      buildSolanaRouterAllowlistCalls({
        allocator,
        client: clientWith({ builder: payloadBuilder }),
        config,
        payloadBuilder,
        router: "0x1234",
        tuples: [{ chain: "solana", depository }],
        value: 1n,
      })
    ).rejects.toThrow(/ROUTER/)
  })
})

describe("resolveTuples", () => {
  it("defaults to the env's recorded Solana depository", () => {
    expect(resolveTuples({ env: "prod" })).toEqual([
      { chain: "solana", depository },
    ])
  })

  it("requires DEPOSITORY where the env records none", () => {
    expect(() => resolveTuples({ env: "stag" })).toThrow(/pass DEPOSITORY/)
    expect(resolveTuples({ depository, env: "stag" })).toEqual([
      { chain: "solana", depository },
    ])
  })

  it("rejects non-Solana chains and a shared DEPOSITORY override", () => {
    expect(() => resolveTuples({ chains: "ethereum", env: "prod" })).toThrow(
      /not solana-vm/
    )
    expect(() =>
      resolveTuples({ chains: "solana,eclipse", depository, env: "prod" })
    ).toThrow(/single chain/)
  })
})
