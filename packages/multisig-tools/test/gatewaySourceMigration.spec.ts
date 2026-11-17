import { readFileSync } from "fs"
import { join } from "path"
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem"
import { describe, expect, it } from "vitest"
import {
  afterPrerequisites,
  buildMigrationCalls,
  migrationAbi,
  migrationEnvironments,
} from "../scripts/generate-migrate-gateway-source"

const arcFeeKey = keccak256(
  `${keccak256(toHex("GATEWAY_VM_SOURCE_TRANSFER_FEE_PPM"))}${keccak256(toHex("arc-gateway")).slice(2)}`
)
const loadDeployment = (env: string) =>
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../contracts/relay-chain/deployments/contracts/${env}.json`
      ),
      "utf8"
    )
  )

describe("Gateway source migration", () => {
  it("only replaces the Polygon builder in dev", () => {
    const deployment = loadDeployment("dev")
    const calls = buildMigrationCalls("dev", deployment, arcFeeKey)
    expect(calls).toHaveLength(1)
    expect(calls[0].onPolygon).toBe(false)
    expect(calls[0].to).toBe(deployment.core.allocator)
    expect(
      decodeFunctionData({ abi: migrationAbi, data: calls[0].calldata })
    ).toEqual({
      args: [
        "polygon-gateway",
        migrationEnvironments.dev.depository.toLowerCase(),
        getAddress(deployment.payloadBuilders.gatewayVmPayloadBuilder),
      ],
      functionName: "setPayloadBuilder",
    })
  })

  it.each(["stag", "prod"] as const)(
    "moves %s to Arc without changing fixed gas fees or Arc deposits",
    (env) => {
      const deployment = loadDeployment(env)
      const calls = buildMigrationCalls(env, deployment, arcFeeKey)
      const decoded = calls.map((call) =>
        decodeFunctionData({ abi: migrationAbi, data: call.calldata })
      )
      expect(calls).toHaveLength(4)
      expect(calls.map((call) => call.onPolygon)).toEqual([
        true,
        false,
        false,
        false,
      ])
      expect(calls.map((call) => call.to)).toEqual([
        migrationEnvironments[env].depository,
        deployment.core.config,
        deployment.core.allocator,
        deployment.core.allocator,
      ])
      expect(decoded[0]).toEqual({
        args: [false],
        functionName: "setDepositsEnabled",
      })
      expect(decoded[1]).toEqual({
        args: [arcFeeKey, zeroHash],
        functionName: "setConfigValue",
      })
      expect(decoded[2].functionName).toBe("setPayloadBuilder")
      expect(decoded[2].args?.map((arg) => String(arg).toLowerCase())).toEqual([
        "arc-gateway",
        migrationEnvironments[env].depository.toLowerCase(),
        deployment.payloadBuilders.gatewayVmPayloadBuilder.toLowerCase(),
      ])
      expect(decoded[3]).toEqual({
        args: [
          "polygon-gateway",
          migrationEnvironments[env].depository.toLowerCase(),
          zeroAddress,
        ],
        functionName: "setPayloadBuilder",
      })
    }
  )

  it("reserves all six pending production Hub nonces", () => {
    expect(afterPrerequisites(199, [199, 200, 201, 202, 203, 204])).toBe(205)
  })

  it("handles partially or fully executed prerequisites", () => {
    expect(afterPrerequisites(203, [199, 200, 201, 202, 203, 204])).toBe(205)
    expect(afterPrerequisites(207, [199, 200, 201, 202, 203, 204])).toBe(207)
    expect(afterPrerequisites(24, [])).toBe(24)
  })

  it.each([
    [200, 201],
    [199, 201],
    [199, 199],
  ])(
    "rejects non-contiguous or duplicate prerequisite nonces %j",
    (...nonces) => {
      expect(() => afterPrerequisites(199, nonces)).toThrow(
        "Non-contiguous prerequisite nonces"
      )
    }
  )
})
