import { readFileSync } from "fs"
import { resolve } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PublicClient } from "viem"

import { checkLitOracleSigners } from "../../deployments/scripts/misc/verify-deployment/lit"

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  readFileSync: vi.fn(),
}))

const signerA = `0x${"ab".repeat(20)}`
const signerB = `0x${"cd".repeat(20)}`
const signerC = `0x${"ef".repeat(20)}`
const multisig = `0x${"12".repeat(20)}`
const allocatorPath = resolve(
  __dirname,
  "../../../../packages/lit-allocator/environments/prod.json"
)
const depositAddressPath = resolve(
  __dirname,
  "../../../../packages/lit-deposit-address/environments/prod.json"
)

const environment = () => ({
  allowedOracles: [signerA, signerB],
  name: "prod",
  oracleSignatureThreshold: 2,
})

let configs: Record<string, ReturnType<typeof environment>>
const readContract = vi.fn()
const context = () => ({
  client: { readContract } as unknown as PublicClient,
  deployment: {
    allocator: `0x${"34".repeat(20)}`,
    depositAddressManager: `0x${"56".repeat(20)}`,
    oracleMultisig: multisig,
  },
  env: "prod",
})

beforeEach(() => {
  configs = {
    [allocatorPath]: environment(),
    [depositAddressPath]: environment(),
  }
  vi.mocked(readFileSync).mockImplementation((path) => {
    const config = configs[String(path)]
    if (!config) throw new Error("Environment config not found")
    return JSON.stringify(config)
  })
  readContract.mockImplementation(async ({ functionName }) =>
    functionName === "getSigners" ? [signerA, signerB] : 2n
  )
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("Lit oracle signer deployment verification", () => {
  it("matches both packages regardless of signer order and address casing", async () => {
    configs[allocatorPath].allowedOracles = [signerB, `0x${"AB".repeat(20)}`]
    expect(await checkLitOracleSigners(context())).toBe(0)
    expect(readContract).toHaveBeenCalledTimes(2)
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: multisig,
        functionName: "getSigners",
      })
    )
    expect(readFileSync).toHaveBeenCalledWith(allocatorPath, "utf8")
    expect(readFileSync).toHaveBeenCalledWith(depositAddressPath, "utf8")
  })

  it.each([allocatorPath, depositAddressPath])(
    "reports missing and extra signers in %s",
    async (path) => {
      configs[path].allowedOracles = [signerA, signerC]
      expect(await checkLitOracleSigners(context())).toBe(1)
      expect(console.log).toHaveBeenCalledWith(
        `    Missing from Lit config: ${signerB}`
      )
      expect(console.log).toHaveBeenCalledWith(
        `    Not authorized by oracleMultisig: ${signerC}`
      )
    }
  )

  it("counts threshold mismatches in each package", async () => {
    configs[allocatorPath].oracleSignatureThreshold = 1
    configs[depositAddressPath].oracleSignatureThreshold = 1
    expect(await checkLitOracleSigners(context())).toBe(2)
  })

  it.each([
    { allowedOracles: [] },
    { allowedOracles: [signerA, `0x${"AB".repeat(20)}`] },
    { allowedOracles: [signerA, `0x${"0".repeat(40)}`] },
    { allowedOracles: ["invalid", signerB] },
    { oracleSignatureThreshold: 0 },
    { oracleSignatureThreshold: 1.5 },
    { oracleSignatureThreshold: 3 },
    { name: "stag" },
  ])("fails invalid Lit configuration %j", async (invalid) => {
    Object.assign(configs[allocatorPath], invalid)
    expect(await checkLitOracleSigners(context())).toBe(1)
  })

  it("counts a missing environment file as a failure and checks the other package", async () => {
    delete configs[allocatorPath]
    expect(await checkLitOracleSigners(context())).toBe(1)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "lit-deposit-address/environments/prod.json: allowedOracles matches"
      )
    )
  })

  it("fails if the multisig read fails", async () => {
    readContract.mockRejectedValue(new Error("RPC unavailable"))
    expect(await checkLitOracleSigners(context())).toBe(1)
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it("fails if the multisig read times out", async () => {
    vi.useFakeTimers()
    readContract.mockImplementation(() => new Promise(() => undefined))
    const result = checkLitOracleSigners(context())
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await result).toBe(1)
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it("counts malformed JSON as a failure", async () => {
    vi.mocked(readFileSync).mockReturnValueOnce("{")
    expect(await checkLitOracleSigners(context())).toBe(1)
  })

  it("fails if oracleMultisig is missing from the deployment", async () => {
    const ctx = context()
    ctx.deployment.oracleMultisig = ""
    expect(await checkLitOracleSigners(ctx)).toBe(1)
    expect(readContract).not.toHaveBeenCalled()
  })

  it("skips the deposit-address config when its contract is not deployed", async () => {
    const ctx = context()
    ctx.deployment.depositAddressManager = ""
    delete configs[depositAddressPath]
    expect(await checkLitOracleSigners(ctx)).toBe(0)
    expect(readFileSync).toHaveBeenCalledTimes(1)
  })

  it("skips on-chain reads when neither Lit contract is deployed", async () => {
    expect(await checkLitOracleSigners({ ...context(), deployment: {} })).toBe(
      0
    )
    expect(readContract).not.toHaveBeenCalled()
  })
})
