import { keccak256, WaitForTransactionReceiptTimeoutError } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  BROADCAST_ATTEMPTS,
  broadcastAndConfirm,
  REJECTION_BACKOFF_MS,
} from "../src/commands/execute-transactions"

// A real signed EIP-1559 tx (stag manifest 009, base) so parseTransaction sees a
// 1559 envelope; only the fee fields matter here.
const SIGNED_TX =
  "0x02f8ae0101830186a08403e8c7b882def194403f0552401b671e04a79e7aa9eb6c9568c2291180b8442f2ff15d6971a606fd170ab214048db850a0dade0bfeed92e1a1b0f03c52f1952f23c3f90000000000000000000000009ddc6a541e8f8b50b0996786a3ec275ab4d3a76cc080a0ad88f4a30e45ad40c515d9cddbdf02f4c2771ee64f714a1844bdea4d76606521a005f16508c0afca8f8ead061469206baad1a75b0ede7cfe9b8f4fad078a9c6309" as const
const HASH = keccak256(SIGNED_TX)
const MAX_FEE = 65587128n // maxFeePerGas encoded in SIGNED_TX

const timeoutError = () =>
  new WaitForTransactionReceiptTimeoutError({ hash: HASH })

const makeClient = (overrides: Record<string, unknown> = {}) =>
  ({
    getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: MAX_FEE - 1n }),
    getFeeHistory: vi
      .fn()
      .mockResolvedValue({ baseFeePerGas: [MAX_FEE + 5n, MAX_FEE - 1n] }),
    getTransaction: vi.fn().mockResolvedValue({ hash: HASH }),
    getTransactionCount: vi.fn().mockResolvedValue(2),
    sendRawTransaction: vi.fn().mockResolvedValue(HASH),
    waitForTransactionReceipt: vi
      .fn()
      .mockResolvedValue({ status: "success", transactionHash: HASH }),
    ...overrides,
  }) as never

describe("broadcastAndConfirm", () => {
  beforeEach(() => {
    // the helper logs every retry; keep the test output readable
    vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("waits for the deterministic hash when the broadcast times out", async () => {
    const client = makeClient({
      sendRawTransaction: vi
        .fn()
        .mockRejectedValue(new Error("The request took too long to respond.")),
    })
    await broadcastAndConfirm(client, SIGNED_TX, "rpc")
    expect(
      (client as any).waitForTransactionReceipt.mock.calls[0][0].hash
    ).toBe(HASH)
  })

  it("fails immediately when another tx consumed the nonce", async () => {
    const client = makeClient({
      getTransaction: vi.fn().mockResolvedValue(null),
      sendRawTransaction: vi.fn().mockRejectedValue(
        Object.assign(new Error("nonce too low"), {
          details: "nonce too low",
        })
      ),
    })
    await expect(broadcastAndConfirm(client, SIGNED_TX, "rpc")).rejects.toThrow(
      /consumed by another transaction/
    )
    expect((client as any).waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it("fetches the receipt when 'nonce too low' means our own tx was mined", async () => {
    const client = makeClient({
      sendRawTransaction: vi.fn().mockRejectedValue(
        Object.assign(new Error("nonce too low"), {
          details: "nonce too low",
        })
      ),
    })
    await broadcastAndConfirm(client, SIGNED_TX, "rpc")
    expect((client as any).waitForTransactionReceipt).toHaveBeenCalledTimes(1)
  })

  it("refuses a receipt that belongs to a replacement tx", async () => {
    const client = makeClient({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        transactionHash: `0x${"ab".repeat(32)}`,
      }),
    })
    await expect(broadcastAndConfirm(client, SIGNED_TX, "rpc")).rejects.toThrow(
      /was replaced by/
    )
  })

  it("backs off after a receipt lookup error instead of re-sending at once", async () => {
    vi.useFakeTimers()
    const client = makeClient({
      waitForTransactionReceipt: vi
        .fn()
        .mockRejectedValueOnce(new Error("429 Too Many Requests"))
        .mockResolvedValue({ status: "success", transactionHash: HASH }),
    })
    const done = broadcastAndConfirm(client, SIGNED_TX, "rpc")
    await vi.advanceTimersByTimeAsync(REJECTION_BACKOFF_MS - 1)
    expect((client as any).sendRawTransaction).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect((client as any).sendRawTransaction).toHaveBeenCalledTimes(2)
  })

  it("broadcasts an underpriced tx when FORCE_BROADCAST=1", async () => {
    process.env.FORCE_BROADCAST = "1"
    try {
      const client = makeClient({
        getFeeHistory: vi
          .fn()
          .mockResolvedValue({ baseFeePerGas: [MAX_FEE + 10n, MAX_FEE + 1n] }),
      })
      await broadcastAndConfirm(client, SIGNED_TX, "rpc")
      expect((client as any).sendRawTransaction).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.FORCE_BROADCAST
    }
  })

  it("treats 'already known' as pending instead of re-sending", async () => {
    const client = makeClient({
      sendRawTransaction: vi.fn().mockRejectedValue(
        Object.assign(new Error("Missing or invalid parameters."), {
          details: "already known",
        })
      ),
      waitForTransactionReceipt: vi
        .fn()
        .mockRejectedValueOnce(timeoutError())
        .mockResolvedValue({ status: "success", transactionHash: HASH }),
    })
    await broadcastAndConfirm(client, SIGNED_TX, "rpc")
    expect((client as any).sendRawTransaction).toHaveBeenCalledTimes(2)
  })

  it("backs off and retries a definitive rejection", async () => {
    vi.useFakeTimers()
    const client = makeClient({
      sendRawTransaction: vi
        .fn()
        .mockRejectedValueOnce(new Error("Transaction execution unsuccessful"))
        .mockResolvedValue(HASH),
    })
    const done = broadcastAndConfirm(client, SIGNED_TX, "rpc")
    await vi.advanceTimersByTimeAsync(REJECTION_BACKOFF_MS)
    await done
    expect((client as any).sendRawTransaction).toHaveBeenCalledTimes(2)
  })

  it("gives up after the attempt budget", async () => {
    vi.useFakeTimers()
    const client = makeClient({
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("rejected")),
    })
    const assertion = expect(
      broadcastAndConfirm(client, SIGNED_TX, "rpc")
    ).rejects.toThrow(/not accepted after 6/)
    await vi.advanceTimersByTimeAsync(REJECTION_BACKOFF_MS * BROADCAST_ATTEMPTS)
    await assertion
  })

  it("fails fast when the manifest fee is below the recent base-fee floor", async () => {
    const client = makeClient({
      getFeeHistory: vi
        .fn()
        .mockResolvedValue({ baseFeePerGas: [MAX_FEE + 10n, MAX_FEE + 1n] }),
    })
    await expect(broadcastAndConfirm(client, SIGNED_TX, "rpc")).rejects.toThrow(
      /underpriced/
    )
    expect((client as any).sendRawTransaction).not.toHaveBeenCalled()
  })

  it("skips the fee check when the RPC has no fee history and no base fee", async () => {
    const client = makeClient({
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: null }),
      getFeeHistory: vi.fn().mockRejectedValue(new Error("method not found")),
    })
    await broadcastAndConfirm(client, SIGNED_TX, "rpc")
    expect((client as any).sendRawTransaction).toHaveBeenCalledTimes(1)
  })

  it("surfaces a revert instead of retrying", async () => {
    const client = makeClient({
      waitForTransactionReceipt: vi
        .fn()
        .mockResolvedValue({ status: "reverted", transactionHash: HASH }),
    })
    await expect(broadcastAndConfirm(client, SIGNED_TX, "rpc")).rejects.toThrow(
      /Transaction reverted/
    )
    expect((client as any).sendRawTransaction).toHaveBeenCalledTimes(1)
  })
})
