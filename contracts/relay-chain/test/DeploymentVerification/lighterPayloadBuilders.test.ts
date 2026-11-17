import { describe, expect, it, vi } from "vitest"
import { keccak256, toBytes } from "viem"
import type { PublicClient } from "viem"

import {
  payloadBuilderKeyFor,
  perCurrencyConfigFor,
} from "../../deployments/scripts/misc/verify-deployment/constants"
import type { ChainEntry } from "../../deployments/scripts/misc/verify-deployment/constants"
import {
  checkPayloadBuilders,
  checkPayloadBuilderConfigs,
} from "../../deployments/scripts/misc/verify-deployment/steps"
import type { Ctx } from "../../deployments/scripts/misc/verify-deployment/steps"

const lighterBuilder = `0x${"a1".repeat(20)}`
const otherBuilder = `0x${"b2".repeat(20)}`
const allocator = `0x${"c3".repeat(20)}`
const configStore = `0x${"d4".repeat(20)}`

// SDK encoding of the Lighter account indices used below: 16-byte big-endian.
const LIGHTER_DEPOSITORY = "730948"
const LIGHTER_DEPOSITORY_ENCODED = "0x000000000000000000000000000b2744"
const ROBINHOOD_LIGHTER_DEPOSITORY = "28482"
const ROBINHOOD_LIGHTER_DEPOSITORY_ENCODED =
  "0x00000000000000000000000000006f42"

const chains: ChainEntry[] = [
  { depository: LIGHTER_DEPOSITORY, id: "lighter", vmType: "lighter-vm" },
  {
    depository: ROBINHOOD_LIGHTER_DEPOSITORY,
    id: "robinhood-lighter",
    vmType: "lighter-vm",
  },
]

const context = (readContract: ReturnType<typeof vi.fn>) =>
  ({
    allocator,
    chains,
    client: { readContract } as unknown as PublicClient,
    configStore,
    deployment: {
      lighterVmPayloadBuilder: lighterBuilder,
    },
  }) as unknown as Ctx

describe("payload builder resolution for Lighter deployments", () => {
  it("resolves every lighter-vm chain to the shared family builder", () => {
    for (const chain of chains) {
      expect(payloadBuilderKeyFor(chain)).toBe("lighterVmPayloadBuilder")
    }
  })

  it("keeps the mainnet currency set for the original Lighter chain", () => {
    expect(payloadBuilderKeyFor(chains[0])).toBe("lighterVmPayloadBuilder")
    expect(perCurrencyConfigFor(chains[0])?.map((c) => c.label)).toEqual([
      "USDC Perp",
      "ETH Spot",
      "USDC Spot",
    ])
  })

  it("routes robinhood-lighter to its USDG-only currency set", () => {
    const currencies = perCurrencyConfigFor(chains[1])
    expect(currencies).toHaveLength(1)
    expect(currencies?.[0]).toMatchObject({
      currency: `0x${"00".repeat(16)}`,
      fns: ["getFromRouteTypeKey", "getToRouteTypeKey", "getAssetIndexKey"],
      label: "USDG Perp",
    })
  })
})

describe("checkPayloadBuilders with two lighter-vm chains", () => {
  const registered: Record<string, string> = {
    [`lighter:${LIGHTER_DEPOSITORY_ENCODED}`]: lighterBuilder,
    [`robinhood-lighter:${ROBINHOOD_LIGHTER_DEPOSITORY_ENCODED}`]:
      lighterBuilder,
  }

  const allocatorReads = (overrides: Record<string, string> = {}) =>
    vi.fn(async ({ args }: { args: [string, string] }) => {
      const key = `${args[0]}:${args[1]}`
      return overrides[key] ?? registered[key] ?? `0x${"00".repeat(20)}`
    })

  it("passes when both chains register the shared builder", async () => {
    const readContract = allocatorReads()
    await expect(checkPayloadBuilders(context(readContract))).resolves.toBe(0)
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["robinhood-lighter", ROBINHOOD_LIGHTER_DEPOSITORY_ENCODED],
        functionName: "payloadBuilders",
      })
    )
  })

  it("fails a lighter-vm chain that declares additional depositories", async () => {
    const readContract = allocatorReads()
    const ctx = context(readContract)
    ctx.chains = [
      { ...chains[0], additionalDepositories: ["99999"] },
      chains[1],
    ]
    await expect(checkPayloadBuilders(ctx)).resolves.toBe(1)
  })

  it("fails when robinhood-lighter still points at a chain-specific builder", async () => {
    const readContract = allocatorReads({
      [`robinhood-lighter:${ROBINHOOD_LIGHTER_DEPOSITORY_ENCODED}`]:
        otherBuilder,
    })
    await expect(checkPayloadBuilders(context(readContract))).resolves.toBe(1)
  })
})

describe("checkPayloadBuilderConfigs with two lighter-vm chains", () => {
  const mockKey = (address: string, functionName: string, args: unknown[]) =>
    keccak256(toBytes(`${address}:${functionName}:${args.join(",")}`))

  const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`

  // Config store as a correctly configured deployment would hold it: each
  // chain's own depository account index and app-chain id, and 3 elsewhere.
  const configured: Record<string, string> = {
    [mockKey(lighterBuilder, "getFromAccountIndexKey", ["lighter"])]: word(
      BigInt(LIGHTER_DEPOSITORY)
    ),
    [mockKey(lighterBuilder, "getLighterChainIdKey", ["lighter"])]: word(304n),
    [mockKey(lighterBuilder, "getFromAccountIndexKey", ["robinhood-lighter"])]:
      word(BigInt(ROBINHOOD_LIGHTER_DEPOSITORY)),
    [mockKey(lighterBuilder, "getLighterChainIdKey", ["robinhood-lighter"])]:
      word(466324n),
  }
  const configuredValue = (key: string): string | undefined =>
    configured[key] ?? word(3n)

  const keyReads = (
    configValue: (_key: string) => string | undefined = configuredValue
  ) =>
    vi.fn(
      async ({
        address,
        functionName,
        args,
      }: {
        address: string
        functionName: string
        args: unknown[]
      }) => {
        if (functionName === "getConfigValue") {
          const value = configValue(args[0] as string)
          if (!value) throw new Error("ConfigValueNotSet")
          return value
        }
        return mockKey(address, functionName, args)
      }
    )

  const builderKeyReads = (
    readContract: ReturnType<typeof keyReads>,
    chainId: string
  ) =>
    readContract.mock.calls
      .map(([call]) => call)
      .filter(
        (call) =>
          call.address === lighterBuilder &&
          call.functionName !== "getConfigValue" &&
          call.args[0] === chainId
      )

  it("resolves instance and currency keys per chain on the shared builder", async () => {
    const readContract = keyReads()
    await expect(
      checkPayloadBuilderConfigs(context(readContract))
    ).resolves.toBe(0)

    const robinhoodKeyReads = builderKeyReads(readContract, "robinhood-lighter")
    expect(robinhoodKeyReads.map((call) => call.functionName)).toEqual([
      "getFromAccountIndexKey",
      "getLighterChainIdKey",
      "getFromRouteTypeKey",
      "getToRouteTypeKey",
      "getAssetIndexKey",
    ])
    for (const call of robinhoodKeyReads.slice(0, 2)) {
      expect(call.args).toEqual(["robinhood-lighter"])
    }
    for (const call of robinhoodKeyReads.slice(2)) {
      expect(call.args).toEqual(["robinhood-lighter", `0x${"00".repeat(16)}`])
    }

    // 2 instance keys + 3 currencies x 3 keys
    expect(builderKeyReads(readContract, "lighter")).toHaveLength(11)
  })

  it("fails a chain whose Lighter app-chain id is unset", async () => {
    const unsetKey = mockKey(lighterBuilder, "getLighterChainIdKey", [
      "robinhood-lighter",
    ])
    const readContract = keyReads((key) =>
      key === unsetKey ? undefined : configuredValue(key)
    )
    await expect(
      checkPayloadBuilderConfigs(context(readContract))
    ).resolves.toBe(1)
  })

  it("fails a chain whose account index is not its depository", async () => {
    const wrongKey = mockKey(lighterBuilder, "getFromAccountIndexKey", [
      "robinhood-lighter",
    ])
    const readContract = keyReads((key) =>
      key === wrongKey ? word(BigInt(LIGHTER_DEPOSITORY)) : configuredValue(key)
    )
    await expect(
      checkPayloadBuilderConfigs(context(readContract))
    ).resolves.toBe(1)
  })

  it("fails a chain that signs with another instance's app-chain id", async () => {
    const wrongKey = mockKey(lighterBuilder, "getLighterChainIdKey", [
      "robinhood-lighter",
    ])
    const readContract = keyReads((key) =>
      key === wrongKey ? word(304n) : configuredValue(key)
    )
    await expect(
      checkPayloadBuilderConfigs(context(readContract))
    ).resolves.toBe(1)
  })
})
