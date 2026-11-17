import { Command } from "commander"
import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  parseAbi,
  zeroAddress,
} from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  bundle: vi.fn(),
  createTransaction: vi.fn(),
  decodeData: vi.fn(),
  getMultisigTransactions: vi.fn(),
  getTransactionHash: vi.fn(),
  readContract: vi.fn(),
  resolveNetwork: vi.fn(),
}))

vi.mock("../src/builders/utils", () => ({
  createTransactionBundle: mocks.bundle,
}))
vi.mock("../src/helpers/safe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/helpers/safe")>()),
  createSafeClientWithRpc: vi.fn().mockResolvedValue({
    apiKit: {
      decodeData: mocks.decodeData,
      getMultisigTransactions: mocks.getMultisigTransactions,
    },
    protocolKit: {
      createTransaction: mocks.createTransaction,
      getTransactionHash: mocks.getTransactionHash,
    },
  }),
}))
vi.mock("../src/helpers/network", () => ({
  assertEnvOrSigner: vi.fn(),
  resolveNetwork: mocks.resolveNetwork,
}))

import { registerCheckHashes } from "../src/commands/check-hashes"

const signer = "0x0000000000000000000000000000000000000001"
const safe = "0x0000000000000000000000000000000000000002"
const multiSend = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2"
const hash = `0x${"ab".repeat(32)}`
const action = { data: "0x1234" as const, to: signer, value: "0" }
const secondAction = { ...action, data: "0xabcd" as const }
const decodedActions = [action, secondAction].map((entry) => ({
  ...entry,
  operation: 0,
}))
const singleTransaction = {
  ...action,
  baseGas: "0",
  gasPrice: "0",
  gasToken: zeroAddress,
  nonce: 165,
  operation: 0,
  refundReceiver: zeroAddress,
  safeTxGas: "0",
}
const encodeBatch = (actions: typeof decodedActions) =>
  encodeFunctionData({
    abi: parseAbi(["function multiSend(bytes transactions)"]),
    args: [
      concatHex(
        actions.map((entry) =>
          encodePacked(
            ["uint8", "address", "uint256", "uint256", "bytes"],
            [
              entry.operation,
              entry.to,
              BigInt(entry.value),
              BigInt((entry.data.length - 2) / 2),
              entry.data,
            ]
          )
        )
      ),
    ],
    functionName: "multiSend",
  })
const batchTransaction = {
  ...singleTransaction,
  data: encodeBatch(decodedActions),
  operation: 1,
  to: multiSend,
}

let pending: Record<string, unknown>
const useBatch = () => {
  mocks.bundle.mockResolvedValue([action, secondAction])
  mocks.createTransaction.mockResolvedValue({ data: batchTransaction })
  pending = { ...pending, ...batchTransaction }
  mocks.decodeData.mockResolvedValue({
    method: "multiSend",
    parameters: [{ valueDecoded: decodedActions }],
  })
}
const run = (options: string[] = []) => {
  const program = new Command()
  registerCheckHashes(program)
  return program.parseAsync(
    [
      "check-hashes",
      "--transactions",
      "manifest.json",
      "--network",
      "aurora",
      "--env",
      "stag",
      "--safe-transaction-nonce",
      "165",
      ...options,
    ],
    { from: "user" }
  )
}

describe("check-hashes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveNetwork.mockReturnValue({
      multisigSignerAddress: signer,
      publicClient: { readContract: mocks.readContract },
      rpc: "https://example.com",
    })
    mocks.readContract.mockResolvedValue(safe)
    mocks.bundle.mockResolvedValue([action])
    mocks.createTransaction.mockResolvedValue({ data: singleTransaction })
    mocks.getTransactionHash.mockResolvedValue(hash)
    mocks.decodeData.mockResolvedValue({ method: "approveSignature" })
    pending = {
      ...singleTransaction,
      isExecuted: false,
      safe,
      safeTxHash: hash,
    }
    mocks.getMultisigTransactions.mockImplementation(async () => ({
      next: null,
      results: [pending],
    }))
  })

  it.each([false, true])(
    "verifies a direct CALL with executed=%s",
    async (executed) => {
      pending.isExecuted = executed
      await run(executed ? ["--executed"] : [])
      expect(mocks.getMultisigTransactions).toHaveBeenCalledWith(safe, {
        executed,
        limit: 2,
        nonce: "165",
      })
      expect(mocks.bundle).toHaveBeenCalledWith("manifest.json", signer, {
        skipEvmStateChecks: executed || undefined,
        skipSimulation: undefined,
      })
      expect(mocks.createTransaction).toHaveBeenCalledWith({
        options: { nonce: 165 },
        transactions: [action],
      })
      expect(mocks.getTransactionHash).toHaveBeenCalledWith({
        data: singleTransaction,
      })
    }
  )

  it.each([false, true])(
    "verifies canonical MultiSendCallOnly with executed=%s",
    async (executed) => {
      useBatch()
      pending.isExecuted = executed
      await run(executed ? ["--executed"] : [])
      expect(mocks.createTransaction).toHaveBeenCalledWith({
        options: { nonce: 165 },
        transactions: [action, secondAction],
      })
    }
  )

  it.each([
    ["to", safe],
    ["operation", 1],
    ["value", "1"],
    ["data", "0xabcd"],
    ["safeTxGas", "1"],
    ["baseGas", "1"],
    ["gasPrice", "1"],
    ["gasToken", signer],
    ["refundReceiver", signer],
  ])("rejects changed direct transaction %s", async (field, value) => {
    pending[field] = value
    await expect(run()).rejects.toThrow(`Safe transaction ${field} mismatch`)
  })

  it.each([
    ["to", safe],
    ["operation", 0],
    ["value", "1"],
    ["data", "0x1234"],
  ])(
    "rejects changed batch %s even when the service reports genuine inner calls",
    async (field, value) => {
      useBatch()
      pending[field] = value
      await expect(run()).rejects.toThrow(`Safe transaction ${field} mismatch`)
    }
  )

  it("rejects an arbitrary delegatecall target carrying genuine batch calldata", async () => {
    useBatch()
    pending.to = safe
    expect(pending.operation).toBe(1)
    await expect(run()).rejects.toThrow("Safe transaction to mismatch")
  })

  it.each([
    { operation: 1, value: "0" },
    { operation: 0, value: "1" },
  ])(
    "rejects altered packed inner fields hidden by the decoder: %j",
    async (fields) => {
      useBatch()
      pending.data = encodeBatch([
        { ...decodedActions[0], ...fields },
        decodedActions[1],
      ])
      await expect(run()).rejects.toThrow("Safe transaction data mismatch")
    }
  )

  it.each(Object.keys(singleTransaction))(
    "rejects missing envelope field %s",
    async (field) => {
      delete pending[field]
      await expect(run()).rejects.toThrow()
    }
  )

  it("rejects a different Safe", async () => {
    pending.safe = signer
    await expect(run()).rejects.toThrow("different Safe")
  })

  it("rejects an inconsistent service transaction hash", async () => {
    pending.safeTxHash = `0x${"cd".repeat(32)}`
    await expect(run()).rejects.toThrow("Safe transaction hash mismatch")
  })

  it("rejects a different nonce", async () => {
    pending.nonce = 166
    await expect(run()).rejects.toThrow("not found")
  })

  it.each([
    { batch: false, executed: false },
    { batch: true, executed: false },
    { batch: false, executed: true },
    { batch: true, executed: true },
  ])(
    "verifies without the service decoder: %j",
    async ({ batch, executed }) => {
      if (batch) useBatch()
      pending.isExecuted = executed
      mocks.decodeData.mockRejectedValue(new Error("404: ABI not found"))
      const log = vi.spyOn(console, "log")
      try {
        await run(executed ? ["--executed"] : [])
        expect(log).toHaveBeenCalledWith(
          `✅ Full Safe transaction matches the manifest! Safe transaction hash: ${hash}`
        )
        expect(mocks.decodeData).not.toHaveBeenCalled()
      } finally {
        log.mockRestore()
      }
    }
  )

  it.each([{ to: safe }, { data: "0xffff" as const }, { operation: 2 }])(
    "rejects altered packed inner actions: %j",
    async (fields) => {
      useBatch()
      pending.data = encodeBatch([
        { ...decodedActions[0], ...fields },
        decodedActions[1],
      ])
      await expect(run()).rejects.toThrow("Safe transaction data mismatch")
    }
  )

  it.each([
    { actions: [] },
    { actions: [decodedActions[0]] },
    { actions: [decodedActions[0], decodedActions[0]] },
    { actions: [decodedActions[1], decodedActions[0]] },
  ])(
    "rejects missing, duplicate or reordered packed actions: %j",
    async ({ actions }) => {
      useBatch()
      pending.data = encodeBatch(actions)
      await expect(run()).rejects.toThrow("Safe transaction data mismatch")
    }
  )

  it("does not bypass Safe verification with --skip-simulation or --executed", async () => {
    useBatch()
    pending.isExecuted = true
    pending.to = safe
    await expect(run(["--executed", "--skip-simulation"])).rejects.toThrow(
      "Safe transaction to mismatch"
    )
  })

  it.each(["-1", "1.5", "1oops", "", "9007199254740992"])(
    "rejects invalid nonce %s before RPC access",
    async (nonce) => {
      await expect(run(["--safe-transaction-nonce", nonce])).rejects.toThrow(
        "non-negative safe integer"
      )
      expect(mocks.resolveNetwork).not.toHaveBeenCalled()
    }
  )
})
