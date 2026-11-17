import { afterEach, expect, it, vi } from "vitest"
import { verifyMessage, type Address, type Hex } from "viem"
import deployment from "../../deployments/contracts/dev.json"

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    getChainId: async () => deployment.chainId,
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "erc20Views":
          return `0x${"11".repeat(20)}`
        case "balanceOf":
        case "allowance":
        case "balances":
          return 1000000n
        case "drawResolvers":
          return true
        default:
          throw new Error(`Unexpected read: ${functionName}`)
      }
    },
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }),
  createWalletClient: () => ({
    writeContract: async () => `0x${"00".repeat(32)}`,
  }),
}))

const originalArgv = process.argv
const originalExitCode = process.exitCode
afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("funds using a native signature over the Hub-bound transfer JSON text", async () => {
  const now = 1_800_000_000
  vi.spyOn(Date, "now").mockReturnValue(now * 1000 + 999)
  vi.stubEnv("DEPOSITOR_PRIVATE_KEY", `0x${"0".repeat(63)}1`)
  vi.stubEnv("ORACLE_URL", "http://localhost:3000")
  vi.stubEnv("ORACLE_API_KEY", "test-key")
  vi.stubEnv("RELAY_RPC_URL", "http://localhost:8545")
  vi.stubEnv("ORIGIN_RPC_URL", "http://localhost:8546")
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  process.exitCode = undefined
  process.argv = [
    "node",
    "fund-pool-account.ts",
    "--amount",
    "1",
    "--decimals",
    "6",
    "--pool",
    `0x${"22".repeat(20)}`,
    "--deposit-tx",
    `0x${"33".repeat(32)}`,
    "--nonce",
    "funding-consent",
  ]
  const post = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          execution: {
            actions: ["0x12"],
            idempotencyKey: `0x${"44".repeat(32)}`,
            signatures: [],
          },
        })
      )
  )
  vi.stubGlobal("fetch", post)
  await import("../../deployments/scripts/misc/fund-pool-account")
  await vi.waitFor(() => {
    expect(console.error).not.toHaveBeenCalled()
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Pool account funded"
    )
  })
  expect(post).toHaveBeenCalledTimes(1)
  const [url, options] = post.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe("http://localhost:3000/attestations/transfer/v1")
  const body = JSON.parse(options.body as string)
  // Fixed field ordering pins the Oracle's compact, lexicographically sorted
  // JSON wire format independently of the script's sorting helper.
  const payload = {
    amount: "1000000",
    chainId: "base",
    currency: `0x${"00".repeat(20)}`,
    expiration: now + 3600,
    hubAddress: deployment.core.hub.toLowerCase(),
    hubChainId: String(deployment.chainId),
    nonce: "funding-consent",
    operation: "transfer",
    owner: body.owner,
    ownerChainId: "base",
    recipient: body.owner,
  }
  expect(body).toMatchObject({
    amount: payload.amount,
    chainId: payload.chainId,
    currency: payload.currency,
    expiration: payload.expiration,
    nonce: payload.nonce,
    ownerChainId: payload.ownerChainId,
    recipient: payload.recipient,
  })
  const verification = {
    address: body.owner as Address,
    signature: body.ownerSignature as Hex,
  }
  expect(
    await verifyMessage({ ...verification, message: JSON.stringify(payload) })
  ).toBe(true)
  expect(
    await verifyMessage({
      ...verification,
      message: JSON.stringify({
        ...payload,
        expiration: payload.expiration + 1,
      }),
    })
  ).toBe(false)
  expect(
    await verifyMessage({
      ...verification,
      message: JSON.stringify({ ...payload, expiration: undefined }),
    })
  ).toBe(false)
  expect(
    await verifyMessage({
      ...verification,
      message: JSON.stringify({ ...payload, hubChainId: "1" }),
    })
  ).toBe(false)
  expect(
    await verifyMessage({
      ...verification,
      message: JSON.stringify({
        ...payload,
        hubAddress: `0x${"55".repeat(20)}`,
      }),
    })
  ).toBe(false)
})
