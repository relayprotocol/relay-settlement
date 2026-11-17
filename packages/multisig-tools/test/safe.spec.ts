import { describe, expect, it, vi } from "vitest"
import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  parseAbi,
  type Hex,
} from "viem"
import {
  decodeSafeTransactionActions,
  getSafeTransactionByNonce,
  getSafeTxActionsByNonce,
} from "../src/helpers/safe"

const safeAddress = "0x0000000000000000000000000000000000000001"
const transaction = {
  data: "0x1234",
  isExecuted: false,
  nonce: 165,
  operation: 0,
  to: "0x0000000000000000000000000000000000000002",
  value: "0",
}

const apiFor = (results: unknown[], next: string | null = null) => ({
  decodeData: vi.fn().mockResolvedValue({ method: "approveSignature" }),
  getMultisigTransactions: vi.fn().mockResolvedValue({ next, results }),
})

describe("Local Safe transaction decoding", () => {
  const wrap = (packed: Hex) =>
    encodeFunctionData({
      abi: parseAbi(["function multiSend(bytes transactions)"]),
      args: [packed],
      functionName: "multiSend",
    })
  const pack = (
    operation: number,
    value: bigint,
    data: Hex,
    length = BigInt((data.length - 2) / 2)
  ) =>
    encodePacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [operation, safeAddress, value, length, data]
    )
  const decode = (data: string) =>
    decodeSafeTransactionActions(
      { ...transaction, data, operation: 1 },
      { multiSend: true }
    )

  it("preserves a direct action without inferring a batch from its selector", () => {
    const action = {
      data: wrap("0x"),
      operation: 0,
      to: safeAddress,
      value: "0",
    }
    expect(decodeSafeTransactionActions(action, { multiSend: false })).toEqual([
      action,
    ])
  })

  it("decodes packed operations, addresses, values and variable-length data in order", () => {
    const value = 2n ** 255n
    expect(
      decode(
        wrap(
          concatHex([
            pack(0, 0n, "0x123456"),
            pack(1, value, "0x"),
            pack(0, 1n, "0xab"),
          ])
        )
      )
    ).toEqual([
      { data: "0x123456", operation: 0, to: safeAddress, value: "0" },
      { data: "0x", operation: 1, to: safeAddress, value: value.toString() },
      { data: "0xab", operation: 0, to: safeAddress, value: "1" },
    ])
  })

  it("decodes an empty batch for the caller to reject by action count", () => {
    expect(decode(wrap("0x"))).toEqual([])
  })

  it.each([
    "0x0",
    "0xgg",
    "0x1234",
    wrap("0x00"),
    wrap(pack(2, 0n, "0x")),
    wrap(pack(0, 0n, "0x12", 2n)),
    wrap(pack(0, 0n, "0x", 2n ** 256n - 1n)),
    wrap(concatHex([pack(0, 0n, "0xab"), "0x00"])),
    concatHex([wrap(pack(0, 0n, "0xab")), "0x00"]),
    wrap(pack(0, 0n, "0xab")).slice(0, -2),
  ])("fails closed on malformed local calldata: %s", (data) => {
    expect(() => decode(data)).toThrow("Unable to decode Safe transaction")
  })
})

describe("Safe transaction lookup", () => {
  it("preserves the complete envelope without consulting the decoder", async () => {
    const envelope = {
      ...transaction,
      gasPrice: "123",
      safe: safeAddress,
      safeTxHash: `0x${"ab".repeat(32)}`,
    }
    const api = apiFor([envelope])
    expect(await getSafeTransactionByNonce(api, safeAddress, 165)).toBe(
      envelope
    )
    expect(api.decodeData).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "looks up the exact nonce with executed=%s",
    async (executed) => {
      const api = apiFor([{ ...transaction, isExecuted: executed }])
      const actions = await getSafeTxActionsByNonce(api, safeAddress, 165, {
        executed,
      })
      expect(api.getMultisigTransactions).toHaveBeenCalledWith(safeAddress, {
        executed,
        limit: 2,
        nonce: "165",
      })
      expect(actions).toMatchObject([
        { data: "0x1234", operation: 0, to: transaction.to, value: "0" },
      ])
    }
  )

  it("selects pending transactions by default", async () => {
    const api = apiFor([transaction])
    await getSafeTxActionsByNonce(api, safeAddress, 165)
    expect(api.getMultisigTransactions.mock.calls[0][1].executed).toBe(false)
  })

  it.each([
    { results: [] },
    { results: [{ ...transaction, isExecuted: true }] },
    { results: [{ ...transaction, nonce: 164 }] },
  ])("rejects missing or incorrect matches", async ({ results }) => {
    await expect(
      getSafeTxActionsByNonce(apiFor(results), safeAddress, 165)
    ).rejects.toThrow("not found")
  })

  it("rejects multiple proposals for the same nonce", async () => {
    await expect(
      getSafeTxActionsByNonce(
        apiFor([transaction, transaction]),
        safeAddress,
        165
      )
    ).rejects.toThrow("Multiple Safe transactions")
  })

  it("does not silently select a transaction from truncated results", async () => {
    await expect(
      getSafeTxActionsByNonce(
        apiFor([transaction], "next-page"),
        safeAddress,
        165
      )
    ).rejects.toThrow("Multiple Safe transactions")
  })

  it("decodes executed multisend transactions", async () => {
    const api = apiFor([{ ...transaction, isExecuted: true }])
    api.decodeData.mockResolvedValue({
      method: "multiSend",
      parameters: [
        {
          valueDecoded: [
            { data: "0xab", operation: 0, to: transaction.to, value: 0 },
            { data: "0xcd", operation: 0, to: transaction.to, value: 1 },
          ],
        },
      ],
    })
    expect(
      await getSafeTxActionsByNonce(api, safeAddress, 165, { executed: true })
    ).toEqual([
      { data: "0xab", operation: 0, to: transaction.to, value: "0" },
      { data: "0xcd", operation: 0, to: transaction.to, value: "1" },
    ])
  })

  it("preserves raw calldata when decoding is unavailable", async () => {
    const api = apiFor([{ ...transaction, isExecuted: true }])
    api.decodeData.mockRejectedValue(new Error("unavailable"))
    expect(
      await getSafeTxActionsByNonce(api, safeAddress, 165, { executed: true })
    ).toEqual([
      { data: "0x1234", operation: 0, to: transaction.to, value: "0" },
    ])
  })

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid nonce %s before calling the service",
    async (nonce) => {
      const api = apiFor([])
      await expect(
        getSafeTxActionsByNonce(api, safeAddress, nonce)
      ).rejects.toThrow("non-negative safe integer")
      expect(api.getMultisigTransactions).not.toHaveBeenCalled()
    }
  )
})
