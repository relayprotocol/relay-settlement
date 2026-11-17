import { decodeFunctionData, parseAbi } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"

const client = vi.hoisted(() => ({
  estimateFeesPerGas: vi.fn(),
  estimateGas: vi.fn(),
  getBlock: vi.fn(),
  getChainId: vi.fn(),
  getCode: vi.fn(),
  getTransactionCount: vi.fn(),
  readContract: vi.fn(),
  simulateBlocks: vi.fn(),
}))

vi.mock("viem", async () => ({
  ...(await vi.importActual<typeof import("viem")>("viem")),
  createPublicClient: () => client,
}))

import { generateWithdrawal } from "../scripts/generate-approval-proxy-withdrawal"

const options = {
  chainId: 4663,
  expectedBalance: 300000000000n,
  expectedOwner: "0x463cB782c8dd0a1887b77336DfF74D60F006F56E",
  proxy: "0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
}

describe("ApprovalProxy withdrawal generator", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    client.getChainId.mockResolvedValue(4663)
    client.getBlock.mockResolvedValue({ baseFeePerGas: 10n, number: 100n })
    client.getCode.mockResolvedValue("0x6000")
    client.readContract.mockImplementation(({ functionName }) =>
      Promise.resolve(
        functionName === "owner" ? options.expectedOwner : 300000000000n
      )
    )
    client.getTransactionCount.mockResolvedValue(4)
    client.estimateGas.mockResolvedValue(74097n)
    client.estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 2n,
    })
  })

  it("encodes a zero-value full-balance withdrawal using pending nonce and fresh fees", async () => {
    const {
      transactions: [transaction],
    } = await generateWithdrawal(options)
    const decoded = decodeFunctionData({
      abi: parseAbi(["function withdraw(address)"]),
      data: transaction.calldata,
    })
    expect(decoded.args).toEqual([options.token])
    expect(transaction).toMatchObject({
      amount: "0",
      from: options.expectedOwner,
      gas: "88917",
      maxFeePerGas: "100",
      maxPriorityFeePerGas: "2",
      nonce: 4,
      to: options.proxy,
    })
    expect(client.getTransactionCount).toHaveBeenCalledWith({
      address: options.expectedOwner,
      blockTag: "pending",
    })
  })

  it("rejects the wrong chain before preparing the call", async () => {
    client.getChainId.mockResolvedValue(1)
    await expect(generateWithdrawal(options)).rejects.toThrow("Chain ID")
    expect(client.estimateGas).not.toHaveBeenCalled()
  })

  it("rejects an unexpected owner", async () => {
    client.readContract.mockResolvedValueOnce(options.token)
    await expect(generateWithdrawal(options)).rejects.toThrow("Owner mismatch")
  })

  it("rejects extra deposits instead of silently withdrawing them", async () => {
    await expect(
      generateWithdrawal({ ...options, expectedBalance: 299999999999n })
    ).rejects.toThrow("Balance mismatch")
    expect(client.estimateGas).not.toHaveBeenCalled()
  })

  it("rejects an empty balance", async () => {
    await expect(
      generateWithdrawal({ ...options, expectedBalance: 0n })
    ).rejects.toThrow("positive")
  })

  it("rejects addresses without deployed code", async () => {
    client.getCode.mockResolvedValue("0x")
    await expect(generateWithdrawal(options)).rejects.toThrow("deployed code")
  })

  it("propagates withdrawal reverts", async () => {
    client.estimateGas.mockRejectedValue(new Error("withdrawal reverted"))
    await expect(generateWithdrawal(options)).rejects.toThrow(
      "withdrawal reverted"
    )
  })

  it("uses only legacy fee fields on a chain without base fees", async () => {
    client.getBlock.mockResolvedValue({ baseFeePerGas: null, number: 100n })
    client.estimateFeesPerGas.mockResolvedValue({ gasPrice: 50n })
    const {
      transactions: [transaction],
    } = await generateWithdrawal(options)
    expect(transaction).toHaveProperty("gasPrice", "50")
    expect(transaction).not.toHaveProperty("maxFeePerGas")
    expect(client.estimateFeesPerGas).toHaveBeenCalledWith({
      chain: null,
      type: "legacy",
    })
  })

  it("adds an exact token transfer to the recipient at the next nonce", async () => {
    client.simulateBlocks.mockResolvedValue([
      {
        calls: [
          { data: "0x", gasUsed: 67880n, status: "success" },
          { data: `0x${"0".repeat(63)}1`, gasUsed: 43478n, status: "success" },
        ],
      },
    ])
    const recipient = "0xbc46F56C0caAC0E934a1c9afaf364701582353B8"
    const { transactions } = await generateWithdrawal({ ...options, recipient })
    expect(transactions).toHaveLength(2)
    expect(transactions[1]).toMatchObject({
      amount: "0",
      from: options.expectedOwner,
      gas: "52174",
      nonce: 5,
      to: options.token,
    })
    const decoded = decodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256) returns(bool)"]),
      data: transactions[1].calldata,
    })
    expect(decoded.args[0].toLowerCase()).toBe(recipient.toLowerCase())
    expect(decoded.args[1]).toBe(300000000000n)
    const calls = client.simulateBlocks.mock.calls[0][0].blocks[0].calls
    expect(calls.map((call: { to: string }) => call.to)).toEqual([
      options.proxy,
      options.token,
    ])
    expect(client.simulateBlocks.mock.calls[1][0].blocks[0].calls[1].gas).toBe(
      52174n
    )
  })

  it("rejects a transfer that fails with the final gas limit", async () => {
    client.simulateBlocks
      .mockResolvedValueOnce([
        {
          calls: [
            { data: "0x", gasUsed: 67880n, status: "success" },
            {
              data: `0x${"0".repeat(63)}1`,
              gasUsed: 43478n,
              status: "success",
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          calls: [
            { data: "0x", gasUsed: 67880n, status: "success" },
            {
              data: "0x",
              error: new Error("out of gas"),
              gasUsed: 52174n,
              status: "failure",
            },
          ],
        },
      ])
    await expect(
      generateWithdrawal({
        ...options,
        recipient: "0xbc46F56C0caAC0E934a1c9afaf364701582353B8",
      })
    ).rejects.toThrow("out of gas")
  })

  it("rejects a transfer that returns false", async () => {
    client.simulateBlocks.mockResolvedValue([
      {
        calls: [
          { data: "0x", gasUsed: 67880n, status: "success" },
          { data: `0x${"0".repeat(64)}`, gasUsed: 43478n, status: "success" },
        ],
      },
    ])
    await expect(
      generateWithdrawal({
        ...options,
        recipient: "0xbc46F56C0caAC0E934a1c9afaf364701582353B8",
      })
    ).rejects.toThrow("transfer returned false")
  })

  it("rejects unsafe return destinations", async () => {
    for (const recipient of [
      options.proxy,
      options.token,
      options.expectedOwner,
      "0x0000000000000000000000000000000000000000",
    ]) {
      await expect(
        generateWithdrawal({ ...options, recipient })
      ).rejects.toThrow("Recipient")
    }
  })
})
