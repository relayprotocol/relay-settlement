import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  keccak256,
  toHex,
} from "viem"
import {
  loadRouterRollout,
  resolveRouterRollout,
} from "../../../contracts/relay-chain/deployments/scripts/routerRollout"
import { networks } from "@relay-protocol/settlement-networks"
import {
  buildCalls,
  configAbi,
} from "../scripts/generate-configure-routed-withdrawal"

const address = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const builder = address(1)
const depository = address(2)
const router = address(3)
const oldRouter = address(4)
const gateway = address(5)
const gatewayBuilder = address(8)
const destinationBuilder = address(9)
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const addressWord = (value: string) => `0x${value.slice(2).padStart(64, "0")}`
const records = {
  core: { allocator: address(6), config: address(7) },
  payloadBuilders: {
    ethereumVmPayloadBuilder: builder,
    gatewayEthereumVmDestinationPayloadBuilder: destinationBuilder,
    gatewayVmPayloadBuilder: gatewayBuilder,
  },
  routerRollout: {
    gatewayDestinations: [{ chain: "ethereum", depository: gateway, router }],
    retiredRouters: [{ chain: "ethereum", depository, router: oldRouter }],
  },
}
const key = (args: unknown) => keccak256(toHex(JSON.stringify(args)))
const destinationBuilderKey = key(["destinationBuilder", "ethereum"])
const destinationDepositoryKey = key(["destinationDepository", "ethereum"])

describe("router rollout manifests", () => {
  it("retains retired tuples independently of current records and validates domains", () => {
    const rollout = resolveRouterRollout(records.routerRollout)
    expect(rollout.retiredRouters[0].router).toBe(oldRouter)
    expect(rollout.gatewayDestinations[0].depository).toBe(gateway)
    expect(() =>
      resolveRouterRollout({
        retiredRouters: [{ chain: "typo", depository, router }],
      })
    ).toThrow()
    expect(() =>
      resolveRouterRollout({
        retiredRouters: [{ chain: "ethereum", depository: address(0), router }],
      })
    ).toThrow()
    expect(() =>
      resolveRouterRollout({
        gatewayDestinations: [{ chain: "ethereum", depository, router }],
        retiredRouters: [{ chain: "ethereum", depository, router }],
      })
    ).toThrow(/both/)
  })

  it("accepts Gateway destinations only on Gateway destination chains", () => {
    // linea is an ethereum-vm domain but not a Gateway destination
    expect(() =>
      resolveRouterRollout({
        gatewayDestinations: [{ chain: "linea", depository: gateway, router }],
      })
    ).toThrow(/Gateway destination chain/)
    expect(
      resolveRouterRollout({
        retiredRouters: [{ chain: "linea", depository, router: oldRouter }],
      }).retiredRouters
    ).toHaveLength(1)
  })

  it("withholds a Gateway allowlist write until its destination builder is configured", async () => {
    const client0 = { readContract: async () => word(0) }
    const configuredWrites = async (
      configured: string,
      configuredDepository: string | null = addressWord(gateway)
    ) => {
      const client = {
        readContract: async (request: {
          functionName: string
          args: unknown[]
        }) => {
          if (request.functionName === "getDestinationBuilderKey")
            return destinationBuilderKey
          if (request.functionName === "getDestinationDepositoryKey")
            return destinationDepositoryKey
          if (request.functionName === "getConfigValue") {
            if (request.args[0] === destinationBuilderKey) return configured
            if (request.args[0] === destinationDepositoryKey) {
              if (configuredDepository === null)
                throw new BaseError("unset", {
                  cause: new ContractFunctionRevertedError({
                    abi: configAbi,
                    data: encodeErrorResult({
                      abi: configAbi,
                      args: [destinationDepositoryKey],
                      errorName: "ConfigValueNotSet",
                    }),
                    functionName: "getConfigValue",
                  }),
                })
              return configuredDepository
            }
            return word(0)
          }
          return key(request.args)
        },
      }
      const { configCalls } = await buildCalls(client as never, builder, [], {
        ...records,
        routerRollout: {
          gatewayDestinations: [
            { chain: "ethereum", depository: gateway, router },
          ],
        },
      })
      const decoded = decodeFunctionData({
        abi: configAbi,
        data: configCalls[0].calldata,
      })
      return new Map(
        (decoded.args![0] as string[]).map((k, i) => [
          k,
          (decoded.args![1] as readonly string[])[i],
        ])
      )
    }
    const gatewayKey = key(["ethereum", gateway, router])
    // Another builder is configured for the chain: only the chain-id write goes out
    const held = await configuredWrites(addressWord(address(12)))
    expect(held.has(gatewayKey)).toBe(false)
    expect(held.size).toBe(1)
    // The expected destination builder is configured: the allowlist write reappears
    const released = await configuredWrites(addressWord(destinationBuilder))
    expect(released.get(gatewayKey)).toBe(word(1))
    // Destination depository not configured yet: hold the allowlist write
    const unsetDepository = await configuredWrites(
      addressWord(destinationBuilder),
      null
    )
    expect(unsetDepository.has(gatewayKey)).toBe(false)
    // Another depository is configured: the record is wrong, refuse the manifest
    await expect(
      configuredWrites(
        addressWord(destinationBuilder),
        addressWord(address(13))
      )
    ).rejects.toThrow(/Gateway destination depository/)

    await expect(
      buildCalls(client0 as never, builder, [], {
        ...records,
        payloadBuilders: { ethereumVmPayloadBuilder: builder },
        routerRollout: {
          gatewayDestinations: [
            { chain: "ethereum", depository: gateway, router },
          ],
        },
      })
    ).rejects.toThrow(/gatewayVmPayloadBuilder/)
  })

  it("rejects a retired tuple that is still recorded, even outside CHAINS", async () => {
    const client = { readContract: async () => word(1) }
    const prodDepository = networks.ethereum.contracts!.prod!
      .depository as `0x${string}`
    const retiredActive = {
      ...records,
      multicallRouters: { ethereum: oldRouter },
      routerRollout: {
        retiredRouters: [
          { chain: "ethereum", depository: prodDepository, router: oldRouter },
        ],
      },
    }
    // CHAINS narrowed the processed chains to none; the record still conflicts
    await expect(
      buildCalls(client as never, builder, [], retiredActive)
    ).rejects.toThrow(/both active and retired/)
    const { builderCalls } = await buildCalls(client as never, builder, [], {
      ...retiredActive,
      multicallRouters: { ethereum: router },
    })
    expect(builderCalls).toEqual([])
  })

  it("adds file retirements without replacing historical records", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-rollout-"))
    try {
      const file = join(dir, "rollout.json")
      writeFileSync(
        file,
        JSON.stringify({
          retiredRouters: [
            { chain: "ethereum", depository: gateway, router: oldRouter },
          ],
        })
      )
      vi.stubEnv("ROUTER_ROLLOUT_FILE", file)
      expect(loadRouterRollout(records.routerRollout).retiredRouters).toEqual([
        ...records.routerRollout.retiredRouters,
        { chain: "ethereum", depository: gateway, router: oldRouter },
      ])
    } finally {
      vi.unstubAllEnvs()
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it("skips matching writes including historical zero keys", async () => {
    const client = {
      readContract: async (request: {
        functionName: string
        args: unknown[]
      }) => {
        if (request.functionName === "getRouterAllowedKey")
          return key(request.args)
        if (request.functionName === "getEvmChainIdKey")
          return key(request.args)
        if (request.functionName === "getDestinationBuilderKey")
          return destinationBuilderKey
        if (request.functionName === "getDestinationDepositoryKey")
          return destinationDepositoryKey
        if (request.functionName === "payloadBuilders") return builder
        if (request.args[0] === destinationBuilderKey)
          return addressWord(destinationBuilder)
        if (request.args[0] === destinationDepositoryKey)
          return addressWord(gateway)
        if (request.args[0] === key(["ethereum", depository, oldRouter]))
          return word(0)
        return word(1)
      },
    }
    const calls = await buildCalls(
      client as never,
      builder,
      [{ chainId: 1n, depository, router, slug: "ethereum" }],
      records
    )
    expect(calls).toEqual({ builderCalls: [], configCalls: [] })
  })

  it("writes zero for historical tuples and one for ordinary and separate Gateway callers", async () => {
    const reads: { functionName: string; args: unknown[] }[] = []
    const client = {
      readContract: async (request: {
        functionName: string
        args: unknown[]
      }) => {
        reads.push(request)
        if (request.functionName === "payloadBuilders") return builder
        if (request.functionName === "getDestinationBuilderKey")
          return destinationBuilderKey
        if (request.functionName === "getDestinationDepositoryKey")
          return destinationDepositoryKey
        if (request.functionName === "getConfigValue") {
          if (request.args[0] === destinationBuilderKey)
            return addressWord(destinationBuilder)
          if (request.args[0] === destinationDepositoryKey)
            return addressWord(gateway)
          return word(9)
        }
        return key(request.args)
      },
    }
    const { configCalls, builderCalls } = await buildCalls(
      client as never,
      builder,
      [{ chainId: 1n, depository, router, slug: "ethereum" }],
      records
    )
    expect(builderCalls).toEqual([])
    const decoded = decodeFunctionData({
      abi: configAbi,
      data: configCalls[0].calldata,
    })
    const writes = new Map(
      (decoded.args![0] as string[]).map((k, i) => [
        k,
        (decoded.args![1] as readonly string[])[i],
      ])
    )
    expect(writes.get(key(["ethereum", depository, oldRouter]))).toBe(word(0))
    expect(writes.get(key(["ethereum", depository, router]))).toBe(word(1))
    expect(writes.get(key(["ethereum", gateway, router]))).toBe(word(1))
    expect(
      reads
        .filter((r) => r.functionName === "payloadBuilders")
        .map((r) => r.args[0])
    ).toEqual(["ethereum"])
  })
})
