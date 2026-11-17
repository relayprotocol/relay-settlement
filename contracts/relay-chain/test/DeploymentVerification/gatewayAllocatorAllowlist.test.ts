import { describe, expect, it, vi } from "vitest"
import {
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  keccak256,
  parseUnits,
  toHex,
} from "viem"
import type { Address, Hex } from "viem"

const depositoryClient = vi.hoisted(() => ({ readContract: vi.fn() }))
vi.mock("viem", async () => ({
  ...(await vi.importActual<typeof import("viem")>("viem")),
  createPublicClient: () => depositoryClient,
}))

import { GATEWAY_CHAINS } from "../../deployments/configs/gateway-vm"
import { verifyGatewayVmConfig } from "../../deployments/scripts/misc/verify-deployment/gateway"
import {
  addressWord,
  uint256Word,
} from "../../deployments/scripts/misc/verify-deployment/helpers"

const builder = `0x${"a1".repeat(20)}` as Address
const destinationBuilder = `0x${"b2".repeat(20)}` as Address
const configStore = `0x${"c3".repeat(20)}` as Address
const relayAllocator = `0x${"d4".repeat(20)}` as Address
const gatewayDepository = `0x${"e5".repeat(20)}` as Address
const gatewayAllocator = `0x${"f6".repeat(20)}` as Address
const chain = GATEWAY_CHAINS.find((entry) => entry.name === "base")!
const gatewayChainId = `${chain.name}-gateway`

// Deterministic keys so the config map can be built from the same formula
const keyFor = (fn: string, args: unknown[]): Hex =>
  keccak256(toHex(`${fn}:${args.join(":")}`))

// The builder deployed before this PR has no 2-arg getAllocatorAllowedKey
const missingGetter = new ContractFunctionExecutionError(
  new ContractFunctionZeroDataError({ functionName: "getAllocatorAllowedKey" }),
  {
    abi: [],
    args: [gatewayChainId, gatewayAllocator],
    contractAddress: builder,
    functionName: "getAllocatorAllowedKey",
  }
)

const hubClient = (
  allowlistGetter: "present" | "missing",
  overrides: Record<string, Hex> = {}
) => {
  const config = new Map<string, Hex>([
    [
      keyFor("getCircleDomainKey", [chain.name]),
      uint256Word(BigInt(chain.domain)),
    ],
    [keyFor("getDomainTokenKey", [chain.name]), addressWord(chain.usdc)],
    [
      keyFor("getDestinationBuilderKey", [chain.name]),
      addressWord(destinationBuilder),
    ],
    [
      keyFor("getDestinationDepositoryKey", [chain.name]),
      addressWord(gatewayDepository),
    ],
    [
      keyFor("getCircleDomainKey", [gatewayChainId]),
      uint256Word(BigInt(chain.domain)),
    ],
    [keyFor("getDomainTokenKey", [gatewayChainId]), addressWord(chain.usdc)],
    [
      keyFor("getGasFeeKey", [gatewayChainId]),
      uint256Word(parseUnits(chain.gasFeeUsdc, 6)),
    ],
    [keyFor("getMaxBlockHeightKey", [gatewayChainId]), uint256Word(1000n)],
    [
      keyFor("getAllocatorAllowedKey", [gatewayChainId, gatewayAllocator]),
      uint256Word(1n),
    ],
  ])
  for (const [key, value] of Object.entries(overrides)) config.set(key, value)
  return {
    readContract: vi.fn(async ({ functionName, args }) => {
      switch (functionName) {
        case "getConfigValue":
          return config.get(args[0])
        case "payloadBuilders":
          return builder
        case "getAllocatorAllowedKey":
          if (allowlistGetter === "missing") throw missingGetter
          return keyFor(functionName, args)
        default:
          return keyFor(functionName, args)
      }
    }),
  }
}

describe("verifyGatewayVmConfig allocator allowlist key", () => {
  const deployment = {
    gatewayEthereumVmDestinationPayloadBuilder: destinationBuilder,
    gatewayVmPayloadBuilder: builder,
  }
  const supported = new Set([chain.name])
  const run = (client: ReturnType<typeof hubClient>) =>
    verifyGatewayVmConfig(
      client,
      deployment,
      configStore,
      relayAllocator,
      supported,
      undefined
    )

  depositoryClient.readContract.mockImplementation(
    async ({ functionName }: { functionName: string }) =>
      ({
        USDC: chain.usdc,
        allocator: gatewayAllocator,
        depositsEnabled: true,
        owner: gatewayAllocator,
      })[functionName]
  )

  it("passes when the builder exposes the chain-scoped getter", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await expect(run(hubClient("present"))).resolves.toBe(0)
    log.mockRestore()
  })

  it("counts a failure instead of rejecting when the builder predates the chain-scoped key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const client = hubClient("missing")
    await expect(run(client)).resolves.toBeGreaterThanOrEqual(1)
    expect(log.mock.calls.flat().join("\n")).toContain(
      "allocator allowlist not chain-scoped by this builder"
    )
    // The remaining report lines for the chain are still produced
    expect(log.mock.calls.flat().join("\n")).toContain("maxBlockHeight=1000")
    log.mockRestore()
  })

  describe("while manifest-register is pending", () => {
    const runPending = (client: ReturnType<typeof hubClient>) =>
      verifyGatewayVmConfig(
        client,
        deployment,
        configStore,
        relayAllocator,
        supported,
        undefined,
        true
      )

    it("allows only the destination builder it will write", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
      const live = hubClient("present", {
        [keyFor("getDestinationBuilderKey", [chain.name])]: addressWord(
          `0x${"99".repeat(20)}`
        ),
      })
      await expect(runPending(live)).resolves.toBe(0)
      expect(log.mock.calls.flat().join("\n")).toContain(
        "pending manifest-register"
      )
      // Without the allowance the same value fails
      await expect(run(live)).resolves.toBe(1)
      log.mockRestore()
    })

    it("still fails a wrong shared value it will not write", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
      const wrongToken = hubClient("present", {
        [keyFor("getDomainTokenKey", [chain.name])]: addressWord(
          `0x${"98".repeat(20)}`
        ),
      })
      await expect(runPending(wrongToken)).resolves.toBe(1)
      log.mockRestore()
    })
  })
})
