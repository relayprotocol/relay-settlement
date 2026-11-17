import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { maxUint256 } from "viem"
import deployment from "../../deployments/contracts/dev.json"

const rpc = vi.hoisted(() => ({
  allowed: true,
  timestamp: 1000n,
  writes: [] as Array<{ functionName: string; args: unknown[] }>,
}))
const address = `0x${"11".repeat(20)}`

vi.mock("viem", async (original) => {
  const actual = await original<typeof import("viem")>()
  return {
    ...actual,
    createPublicClient: () => ({
      getBlock: async () => ({ timestamp: rpc.timestamp }),
      getChainId: async () => deployment.chainId,
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "erc20Views":
            return address
          case "drawNonces":
            return 10n
          case "configEpoch":
            return 3n
          case "drawResolvers":
            return rpc.allowed
          case "drawConfig":
            return [1n, maxUint256, address, 0n]
          default:
            throw new Error(`Unexpected read: ${functionName}`)
        }
      },
      waitForTransactionReceipt: async () => ({ status: "success" }),
    }),
    createWalletClient: () => ({
      writeContract: async (call: {
        functionName: string
        args: unknown[]
      }) => {
        rpc.writes.push(call)
        if (call.functionName === "setDrawResolver") rpc.allowed = true
        return `0x${"00".repeat(32)}`
      },
    }),
  }
})

describe("setup-pool-account contract-wallet flow", () => {
  const originalArgv = process.argv
  const originalExitCode = process.exitCode
  beforeEach(() => {
    vi.resetModules()
    rpc.allowed = true
    rpc.timestamp = 1000n
    rpc.writes = []
    vi.stubEnv("ACCOUNT_PRIVATE_KEY", undefined)
    vi.stubEnv("RELAYER_PRIVATE_KEY", `0x${"0".repeat(63)}1`)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    process.exitCode = undefined
  })
  afterEach(() => {
    process.argv = originalArgv
    process.exitCode = originalExitCode
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  async function run(...args: string[]) {
    vi.resetModules()
    vi.mocked(console.log).mockClear()
    vi.mocked(console.error).mockClear()
    process.argv = [
      "node",
      "setup-pool-account.ts",
      "--cap",
      "1",
      "--account",
      address,
      "--pool",
      address,
      "--resolver",
      address,
      "--authorizer",
      address,
      ...args,
    ]
    await import("../../deployments/scripts/misc/setup-pool-account")
    await vi.waitFor(() => {
      const output = vi.mocked(console.log).mock.calls.flat().join("\n")
      expect(
        vi.mocked(console.error).mock.calls.length > 0 ||
          /Account configured|Have the account sign|stopping before any transaction/.test(
            output
          )
      ).toBe(true)
    })
  }

  it("relays only the config signature when the resolver is already allowed", async () => {
    await run("--config-signature", "0x1234")
    expect(console.error).not.toHaveBeenCalled()
    expect(rpc.writes.map((call) => call.functionName)).toEqual([
      "setDrawConfig",
    ])
    expect(rpc.writes[0].args).toEqual([
      expect.objectContaining({ nonce: 11n }),
      "0x1234",
    ])
  })

  it.each(["--print-messages", "--dry-run"])(
    "allows %s without any signatures",
    async (mode) => {
      await run(mode)
      expect(console.error).not.toHaveBeenCalled()
      expect(rpc.writes).toEqual([])
    }
  )

  it("preserves the signed absolute deadline when relaying later", async () => {
    await run("--config-signature", "0x1234", "--deadline-at", "4000")
    expect(console.error).not.toHaveBeenCalled()
    expect(rpc.writes[0].args[0]).toMatchObject({ deadline: 4000n, epoch: 3n })
  })

  it("uses the same current epoch and consecutive nonces for a new account batch", async () => {
    rpc.allowed = false
    await run("--resolver-signature", "0xabcd", "--config-signature", "0x1234")
    expect(console.error).not.toHaveBeenCalled()
    expect(rpc.writes.map((call) => call.args[0])).toEqual([
      expect.objectContaining({ epoch: 3n, nonce: 11n }),
      expect.objectContaining({ epoch: 3n, nonce: 12n }),
    ])
  })

  it("submits exactly the printed config after the chain timestamp advances", async () => {
    await run("--print-messages")
    expect(console.error).not.toHaveBeenCalled()
    const printed = JSON.parse(
      vi
        .mocked(console.log)
        .mock.calls.map(([message]) => String(message))
        .find((message) => message.startsWith("{"))!
    )
    rpc.timestamp = 1100n
    await run(
      "--config-signature",
      "0x1234",
      "--nonce",
      printed.nonce,
      "--deadline-at",
      printed.deadline
    )
    expect(console.error).not.toHaveBeenCalled()
    const submitted = JSON.parse(
      JSON.stringify(rpc.writes[0].args[0], (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    )
    expect(submitted).toEqual(printed)
  })

  it("requires the resolver signature before broadcasting either update when not allowed", async () => {
    rpc.allowed = false
    await run("--config-signature", "0x1234")
    expect(console.error).toHaveBeenCalled()
    expect(rpc.writes).toEqual([])
  })
})
