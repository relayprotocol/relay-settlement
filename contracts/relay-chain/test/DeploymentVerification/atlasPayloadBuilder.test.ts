import { describe, expect, it, vi } from "vitest"
import {
  encodeFunctionData,
  keccak256,
  toBytes,
  toFunctionSelector,
} from "viem"
import type { PublicClient } from "viem"

import { builderKeyAbi } from "../../deployments/scripts/misc/verify-deployment/constants"
import type { ChainEntry } from "../../deployments/scripts/misc/verify-deployment/constants"
import { checkPayloadBuilderConfigs } from "../../deployments/scripts/misc/verify-deployment/steps"
import type { Ctx } from "../../deployments/scripts/misc/verify-deployment/steps"

const atlasBuilder = `0x${"a1".repeat(20)}`
const configStore = `0x${"d4".repeat(20)}`
const USDT = "0x00000000000000000000000000000002"

const atlasTestnet: ChainEntry = {
  depository: `0x${"e5".repeat(20)}`,
  id: "atlas-testnet",
  vmType: "atlas-vm",
}

const context = (
  readContract: ReturnType<typeof vi.fn>,
  chains: ChainEntry[] = [atlasTestnet]
) =>
  ({
    chains,
    client: { readContract } as unknown as PublicClient,
    configStore,
    deployment: { atlasVmPayloadBuilder: atlasBuilder },
  }) as unknown as Ctx

const mockKey = (functionName: string, args: unknown[]) =>
  keccak256(toBytes(`${atlasBuilder}:${functionName}:${args.join(",")}`))

const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`

describe("checkPayloadBuilderConfigs for atlas-vm", () => {
  // Config store of a correctly configured atlas-testnet deployment: testnet
  // signing domain (chain id 43003, deployment salt), expiration delay and
  // USDT decimals.
  const configured = (): Record<string, string> => ({
    [mockKey("getDomainChainIdKey", ["atlas-testnet"])]: word(43003n),
    [mockKey("getDomainSaltKey", ["atlas-testnet"])]:
      "0xcc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338",
    [mockKey("getExpirationKey", ["atlas-testnet"])]: word(3600n),
    [mockKey("getAssetDecimalsKey", ["atlas-testnet", USDT])]: word(6n),
  })

  const keyReads = (config: Record<string, string>) =>
    vi.fn(
      async ({
        functionName,
        args,
      }: {
        functionName: string
        args: unknown[]
      }) => {
        if (functionName === "getConfigValue") {
          const value = config[args[0] as string]
          if (!value) throw new Error("ConfigValueNotSet")
          return value
        }
        return mockKey(functionName, args)
      }
    )

  it("passes the testnet domain and USDT decimals", async () => {
    const readContract = keyReads(configured())
    await expect(
      checkPayloadBuilderConfigs(context(readContract))
    ).resolves.toBe(0)
  })

  it("fails a domain chain id other than the testnet one", async () => {
    const config = configured()
    config[mockKey("getDomainChainIdKey", ["atlas-testnet"])] = word(1n)
    await expect(
      checkPayloadBuilderConfigs(context(keyReads(config)))
    ).resolves.toBe(1)
  })

  it("fails an unset domain salt", async () => {
    const config = configured()
    delete config[mockKey("getDomainSaltKey", ["atlas-testnet"])]
    await expect(
      checkPayloadBuilderConfigs(context(keyReads(config)))
    ).resolves.toBe(1)
  })

  // The Atlas expiration key is per chain, unlike the EVM, Tron and Solana ones
  it("encodes the per-chain expiration getter", () => {
    expect(
      encodeFunctionData({
        abi: builderKeyAbi,
        args: ["atlas-testnet"],
        functionName: "getExpirationKey",
      }).slice(0, 10)
    ).toBe(toFunctionSelector("getExpirationKey(string)"))
  })

  it("fails an unset expiration delay", async () => {
    const config = configured()
    delete config[mockKey("getExpirationKey", ["atlas-testnet"])]
    await expect(
      checkPayloadBuilderConfigs(context(keyReads(config)))
    ).resolves.toBe(1)
  })

  it("fails unset USDT decimals", async () => {
    const config = configured()
    delete config[mockKey("getAssetDecimalsKey", ["atlas-testnet", USDT])]
    await expect(
      checkPayloadBuilderConfigs(context(keyReads(config)))
    ).resolves.toBe(1)
  })

  it("fails an Atlas chain with no recorded signing domain", async () => {
    const atlasMainnet = { ...atlasTestnet, id: "atlas" }
    const config = {
      [mockKey("getDomainChainIdKey", ["atlas"])]: word(43003n),
      [mockKey("getDomainSaltKey", ["atlas"])]:
        "0xcc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338",
      [mockKey("getExpirationKey", ["atlas"])]: word(3600n),
      [mockKey("getAssetDecimalsKey", ["atlas", USDT])]: word(6n),
    }
    await expect(
      checkPayloadBuilderConfigs(context(keyReads(config), [atlasMainnet]))
    ).resolves.toBe(1)
  })
})
