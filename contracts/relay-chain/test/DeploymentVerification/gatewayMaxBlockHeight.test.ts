import { describe, expect, it, vi } from "vitest"
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  encodeErrorResult,
  toHex,
} from "viem"
import type { Hex } from "viem"

import { configStoreAbi } from "../../deployments/scripts/misc/verify-deployment/constants"
import { reportGatewayMaxBlockHeight } from "../../deployments/scripts/misc/verify-deployment/gateway"
import { readConfigValueState } from "../../deployments/scripts/misc/verify-deployment/helpers"

const configStore = `0x${"d4".repeat(20)}` as const
const key = `0x${"e5".repeat(32)}` as const
const chain = "base-gateway"

// The errors viem raises for each read outcome
const configValueNotSet = new ContractFunctionExecutionError(
  new ContractFunctionRevertedError({
    abi: configStoreAbi,
    data: encodeErrorResult({
      abi: configStoreAbi,
      args: [key],
      errorName: "ConfigValueNotSet",
    }),
    functionName: "getConfigValue",
  }),
  {
    abi: configStoreAbi,
    args: [key],
    contractAddress: configStore,
    functionName: "getConfigValue",
  }
)
const missingGetter = new ContractFunctionExecutionError(
  new ContractFunctionZeroDataError({ functionName: "getMaxBlockHeightKey" }),
  {
    abi: [],
    args: [chain],
    contractAddress: configStore,
    functionName: "getMaxBlockHeightKey",
  }
)
// A builder whose fallback reverts with empty returndata: viem keeps raw 0x
// and decodes nothing
const emptyRevertGetter = new ContractFunctionExecutionError(
  new ContractFunctionRevertedError({
    abi: [],
    data: "0x",
    functionName: "getMaxBlockHeightKey",
  }),
  {
    abi: [],
    args: [chain],
    contractAddress: configStore,
    functionName: "getMaxBlockHeightKey",
  }
)
const rpcDown = new HttpRequestError({
  details: "fetch failed",
  url: "https://rpc.example",
})

const clientReturning = (value: unknown) => ({
  readContract: vi.fn(async () => {
    if (value instanceof Error) throw value
    return value
  }),
})
const keyReader = (outcome: Hex | Error) => async (): Promise<Hex> => {
  if (outcome instanceof Error) throw outcome
  return outcome
}

describe("readConfigValueState", () => {
  it("treats the Config store's ConfigValueNotSet revert as unset", async () => {
    await expect(
      readConfigValueState(clientReturning(configValueNotSet), configStore, key)
    ).resolves.toEqual({ state: "unset" })
  })

  it("treats any other failure as unavailable", async () => {
    await expect(
      readConfigValueState(clientReturning(rpcDown), configStore, key)
    ).resolves.toMatchObject({ state: "unavailable" })
    await expect(
      readConfigValueState(
        clientReturning(new Error("ConfigValueNotSet")),
        configStore,
        key
      )
    ).resolves.toMatchObject({ state: "unavailable" })
  })
})

describe("reportGatewayMaxBlockHeight", () => {
  it("reports an unset ceiling as unbounded without failing", async () => {
    const client = clientReturning(configValueNotSet)
    const report = await reportGatewayMaxBlockHeight(
      client,
      configStore,
      keyReader(key),
      chain
    )
    expect(report.failed).toBe(false)
    expect(report.line).toContain(
      `${chain}: maxBlockHeight unset (burn-intent height is unbounded)`
    )
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ args: [key], functionName: "getConfigValue" })
    )
  })

  it("reports an explicit zero ceiling as disabling new payloads", async () => {
    const report = await reportGatewayMaxBlockHeight(
      clientReturning(toHex(0, { size: 32 })),
      configStore,
      keyReader(key),
      chain
    )
    expect(report).toEqual({
      failed: false,
      line: expect.stringContaining(
        `${chain}: maxBlockHeight=0 (new Gateway payloads disabled)`
      ),
    })
  })

  it("reports a configured ceiling", async () => {
    const report = await reportGatewayMaxBlockHeight(
      clientReturning(toHex(22_000_000, { size: 32 })),
      configStore,
      keyReader(key),
      chain
    )
    expect(report).toEqual({
      failed: false,
      line: expect.stringContaining(`${chain}: maxBlockHeight=22000000`),
    })
  })

  it("reports a builder without the getter as unsupported without failing", async () => {
    const client = clientReturning(toHex(1, { size: 32 }))
    const report = await reportGatewayMaxBlockHeight(
      client,
      configStore,
      keyReader(missingGetter),
      chain
    )
    expect(report.failed).toBe(false)
    expect(report.line).toContain(
      `${chain}: maxBlockHeight not supported by this builder`
    )
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it("reports a builder whose getter reverts with empty returndata as unsupported", async () => {
    const client = clientReturning(toHex(1, { size: 32 }))
    const report = await reportGatewayMaxBlockHeight(
      client,
      configStore,
      keyReader(emptyRevertGetter),
      chain
    )
    expect(report.failed).toBe(false)
    expect(report.line).toContain(
      `${chain}: maxBlockHeight not supported by this builder`
    )
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it("does not treat an empty-returndata revert on the value read as unset", async () => {
    await expect(
      readConfigValueState(clientReturning(emptyRevertGetter), configStore, key)
    ).resolves.toMatchObject({ state: "unavailable" })
  })

  it("fails instead of reporting unbounded when the value read hits an RPC error", async () => {
    const report = await reportGatewayMaxBlockHeight(
      clientReturning(rpcDown),
      configStore,
      keyReader(key),
      chain
    )
    expect(report.failed).toBe(true)
    expect(report.line).toContain(`${chain}: maxBlockHeight could not be read`)
    expect(report.line).not.toContain("unbounded")
  })

  it("fails instead of reporting unsupported when the key read hits an RPC error", async () => {
    const report = await reportGatewayMaxBlockHeight(
      clientReturning(toHex(1, { size: 32 })),
      configStore,
      keyReader(rpcDown),
      chain
    )
    expect(report.failed).toBe(true)
    expect(report.line).toContain(
      `${chain}: maxBlockHeight key could not be read`
    )
    expect(report.line).not.toContain("not supported")
  })
})
