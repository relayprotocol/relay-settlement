import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  keccak256,
  parseAbi,
  toHex,
} from "viem"
import {
  buildGrant,
  resolveGrants,
} from "../scripts/generate-grant-router-depository-role"
import { networks } from "@relay-protocol/settlement-networks"
import { checkRoutedWithdrawalWiring } from "../../../contracts/relay-chain/deployments/scripts/misc/verify-deployment/steps"

const destination = {
  estimateFeesPerGas: vi.fn(async () => ({
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 100000000n,
  })),
  estimateGas: vi.fn(async () => 100n),
  getChainId: vi.fn(async () => 1),
  getCode: vi.fn(async () => "0x01"),
  getTransactionCount: vi.fn(async () => 2),
  readContract: vi.fn(async (_request: { args?: readonly unknown[] }) => true),
}
const destinationClient = () => destination as never
const address = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const tuple = { chain: "ethereum", depository: address(2), router: address(3) }
const retired = { ...tuple, router: address(4) }
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const addressWord = (value: string) => `0x${value.slice(2).padStart(64, "0")}`
const gatewayDestinationBuilder = address(10)
const gatewayBuilder = address(11)
const allowedKey = keccak256(toHex("allowed"))
const destinationBuilderKey = keccak256(toHex("destinationBuilder"))
const destinationDepositoryKey = keccak256(toHex("destinationDepository"))
const context = (rollout: unknown, value: number) => ({
  allocator: address(7),
  chains: [],
  client: {
    readContract: async ({
      address: target,
      functionName,
      args,
    }: {
      address: string
      functionName: string
      args: unknown[]
    }) => {
      if (functionName === "getDestinationBuilderKey") {
        expect(target).toBe(gatewayBuilder)
        return destinationBuilderKey
      }
      if (functionName === "getDestinationDepositoryKey") {
        expect(target).toBe(gatewayBuilder)
        return destinationDepositoryKey
      }
      if (functionName === "getRouterAllowedKey") {
        const expected =
          (
            rollout as {
              retiredRouters?: (typeof tuple)[]
              gatewayDestinations?: (typeof tuple)[]
            }
          ).retiredRouters?.[0] ?? tuple
        expect(args).toEqual([
          expected.chain,
          expected.depository,
          expected.router,
        ])
        return allowedKey
      }
      if (functionName === "getEvmChainIdKey")
        return keccak256(toHex("chainId"))
      if (functionName === "getConfigValue") {
        if (args[0] === keccak256(toHex("chainId"))) return word(1)
        if (args[0] === destinationBuilderKey)
          return addressWord(gatewayDestinationBuilder)
        if (args[0] === destinationDepositoryKey)
          return addressWord(tuple.depository)
        return word(value)
      }
      throw new Error(`unexpected ${functionName}`)
    },
  },
  configStore: address(6),
  deployment: {
    ethereumVmPayloadBuilder: address(8),
    gatewayEthereumVmDestinationPayloadBuilder: gatewayDestinationBuilder,
    gatewayVmPayloadBuilder: gatewayBuilder,
  },
  deploymentFile: { routerRollout: rollout },
  destinationClient,
  env: "prod",
})

describe("rollout destination and verifier wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    destination.readContract.mockResolvedValue(true)
  })
  it("generates the explicit Gateway caller grant with an independent nonce", async () => {
    destination.readContract.mockResolvedValue(false)
    const tx = await buildGrant(
      "ethereum",
      address(9),
      tuple,
      1,
      destinationClient
    )
    const decoded = decodeFunctionData({
      abi: parseAbi(["function grantRole(bytes32 role, address account)"]),
      data: tx!.calldata,
    })
    expect(decoded.args).toEqual([
      keccak256(toHex("DEPOSITORY_ROLE")),
      tuple.depository,
    ])
    expect(tx!.to).toBe(tuple.router)
    expect(tx!.nonce).toBe(3)
  })
  it("skips a Gateway role grant that already exists", async () => {
    expect(
      await buildGrant("ethereum", address(9), tuple, 0, destinationClient)
    ).toBeUndefined()
    expect(destination.estimateGas).not.toHaveBeenCalled()
  })

  it("rejects a destination RPC serving the wrong signing domain", async () => {
    destination.getChainId.mockResolvedValueOnce(10)
    await expect(
      buildGrant("ethereum", address(9), tuple, 0, destinationClient)
    ).rejects.toThrow(/expected 1/)
  })

  it("fails verification when the Gateway signature domain is stale", async () => {
    const ctx = context({ gatewayDestinations: [tuple] }, 1)
    const read = ctx.client.readContract
    ctx.client.readContract = async (request) => {
      if (
        request.functionName === "getConfigValue" &&
        request.args[0] === keccak256(toHex("chainId"))
      )
        return word(10)
      return read(request)
    }
    expect(await checkRoutedWithdrawalWiring(ctx as never)).toBe(1)
  })

  it("counts a Gateway destination on a non-Gateway chain as a failure", async () => {
    // A bad rollout record must not abort the verifier's remaining steps
    expect(
      await checkRoutedWithdrawalWiring(
        context(
          { gatewayDestinations: [{ ...tuple, chain: "linea" }] },
          1
        ) as never
      )
    ).toBe(1)
  })

  it("fails a Gateway destination whose configured destination builder differs", async () => {
    const ctx = context({ gatewayDestinations: [tuple] }, 1)
    const read = ctx.client.readContract
    ctx.client.readContract = async (request) => {
      if (
        request.functionName === "getConfigValue" &&
        request.args[0] === destinationBuilderKey
      )
        return addressWord(address(12))
      return read(request)
    }
    expect(await checkRoutedWithdrawalWiring(ctx as never)).toBe(1)
    expect(
      await checkRoutedWithdrawalWiring(
        context({ gatewayDestinations: [tuple] }, 1) as never
      )
    ).toBe(0)
    const undeclared = context({ gatewayDestinations: [tuple] }, 1)
    undeclared.deployment = { ethereumVmPayloadBuilder: address(8) } as never
    expect(await checkRoutedWithdrawalWiring(undeclared as never)).toBe(1)
  })

  it("refuses to grant a recorded router that is also retired", async () => {
    const depository = networks.ethereum.contracts!.prod!
      .depository as `0x${string}`
    const rollout = {
      gatewayDestinations: [],
      retiredRouters: [{ chain: "ethereum", depository, router: address(4) }],
    }
    await expect(
      resolveGrants(["ethereum"], rollout, {
        multicallRouters: { ethereum: address(4) },
      })
    ).rejects.toThrow(/both active and retired/)
    // CHAINS excluding the chain does not bypass the guard
    await expect(
      resolveGrants([], rollout, {
        multicallRouters: { ethereum: address(4) },
      })
    ).rejects.toThrow(/both active and retired/)
    expect(
      await resolveGrants(["ethereum"], rollout, {
        multicallRouters: { ethereum: address(3) },
      })
    ).toEqual([{ slug: "ethereum" }])
  })

  it("anchors a Gateway tuple's depository to the Config destination depository", async () => {
    const withDepository = (configured: string) => {
      const ctx = context({ gatewayDestinations: [tuple] }, 1)
      const read = ctx.client.readContract
      ctx.client.readContract = async (request) => {
        if (
          request.functionName === "getConfigValue" &&
          request.args[0] === destinationDepositoryKey
        )
          return configured
        return read(request)
      }
      return ctx
    }
    const records = {
      core: { config: address(6) },
      multicallRouters: {},
      payloadBuilders: { gatewayVmPayloadBuilder: gatewayBuilder },
    }
    const rollout = { gatewayDestinations: [tuple], retiredRouters: [] }

    // Config names another depository than the record: verifier fails, no grant
    const wrong = withDepository(addressWord(address(13)))
    expect(await checkRoutedWithdrawalWiring(wrong as never)).toBe(1)
    await expect(
      resolveGrants([], rollout, records, wrong.client as never)
    ).rejects.toThrow(/Gateway destination depository/)
    // Record without the Config address or Gateway builder cannot be checked
    await expect(
      resolveGrants(
        [],
        rollout,
        { multicallRouters: {} },
        wrong.client as never
      )
    ).rejects.toThrow(/gatewayVmPayloadBuilder/)

    // Config matches the record: both pass
    const right = withDepository(addressWord(tuple.depository))
    expect(await checkRoutedWithdrawalWiring(right as never)).toBe(0)
    expect(
      await resolveGrants([], rollout, records, right.client as never)
    ).toEqual([{ slug: "ethereum", tuple }])
  })

  it("detects any nonzero historical key even without current router records", async () => {
    expect(
      await checkRoutedWithdrawalWiring(
        context({ retiredRouters: [retired] }, 2) as never
      )
    ).toBe(1)
    expect(
      await checkRoutedWithdrawalWiring(
        context({ retiredRouters: [retired] }, 0) as never
      )
    ).toBe(0)
  })
  it("fails retired verification when Config RPC fails after the key getter succeeds", async () => {
    const ctx = context({ retiredRouters: [retired] }, 1)
    const read = ctx.client.readContract
    let getterSucceeded = false
    ctx.client.readContract = async (request) => {
      if (request.functionName === "getRouterAllowedKey") {
        const key = await read(request)
        getterSucceeded = true
        return key
      }
      throw new Error("RPC timeout")
    }
    expect(await checkRoutedWithdrawalWiring(ctx as never)).toBe(1)
    expect(getterSucceeded).toBe(true)
  })

  it("requires an explicit zero even for an authentic unset Config key", async () => {
    const ctx = context({ retiredRouters: [retired] }, 1)
    const read = ctx.client.readContract
    const abi = parseAbi(["error ConfigValueNotSet(bytes32 key)"])
    const revert = new ContractFunctionRevertedError({
      abi,
      data: encodeErrorResult({
        abi,
        args: [allowedKey],
        errorName: "ConfigValueNotSet",
      }),
      functionName: "getConfigValue",
    })
    expect(revert.data?.errorName).toBe("ConfigValueNotSet")
    ctx.client.readContract = async (request) => {
      if (request.functionName === "getConfigValue")
        throw new BaseError("read failed", { cause: revert })
      return read(request)
    }
    expect(await checkRoutedWithdrawalWiring(ctx as never)).toBe(1)
  })

  it("checks the separate Gateway caller role and exact tuple", async () => {
    destination.readContract.mockResolvedValue(false)
    expect(
      await checkRoutedWithdrawalWiring(
        context({ gatewayDestinations: [tuple] }, 1) as never
      )
    ).toBeGreaterThan(0)
    expect(
      destination.readContract.mock.calls.some(([request]) => {
        const args = (request as { args?: string[] })?.args
        return (
          args?.[0] === keccak256(toHex("DEPOSITORY_ROLE")) &&
          args[1] === tuple.depository
        )
      })
    ).toBe(true)
    destination.readContract.mockResolvedValue(true)
    expect(
      await checkRoutedWithdrawalWiring(
        context({ gatewayDestinations: [tuple] }, 1) as never
      )
    ).toBe(0)
    expect(
      await checkRoutedWithdrawalWiring(
        context({ gatewayDestinations: [tuple] }, 0) as never
      )
    ).toBeGreaterThan(0)
  })
})
