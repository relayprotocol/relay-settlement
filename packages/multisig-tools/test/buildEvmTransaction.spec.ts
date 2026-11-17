import { readFileSync } from "fs"
import { join } from "path"
import { keccak256, parseTransaction, serializeTransaction } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the network client so `buildEvmTransaction` can run without RPC access.
// Everything else (serialization, hashing) uses the real viem implementation.
const publicClientMock = {
  estimateGas: vi.fn(),
  getChainId: vi.fn(),
  getTransactionCount: vi.fn(),
  simulateBlocks: vi.fn(),
}

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem")
  return {
    ...actual,
    createPublicClient: () => publicClientMock,
  }
})

describe("dependent EVM transactions", () => {
  const tx = (nonce: number, sender: string) =>
    EthereumTxSchema.parse({
      amount: "0",
      calldata: "0x1234",
      family: "ethereum-vm",
      from: sender,
      gas: "100000",
      maxFeePerGas: "100",
      maxPriorityFeePerGas: "0",
      nonce,
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      to: "0x0000000000000000000000000000000000000002",
    })
  beforeEach(() => {
    publicClientMock.getChainId.mockResolvedValue(4663)
    publicClientMock.getTransactionCount.mockResolvedValue(0)
    publicClientMock.estimateGas.mockRejectedValue(
      new Error("insufficient token balance")
    )
    publicClientMock.simulateBlocks.mockReset()
  })
  it("simulates a preceding funding transaction before the dependent call", async () => {
    publicClientMock.simulateBlocks.mockResolvedValue([
      {
        calls: [
          { data: "0x", gasUsed: 40000n, status: "success" },
          { data: "0x", gasUsed: 30000n, status: "success" },
        ],
      },
    ])
    const sender = "0x0000000000000000000000000000000000000003"
    await expect(
      buildEvmTransaction(tx(1, sender), [tx(0, sender)])
    ).resolves.toBeDefined()
    expect(
      publicClientMock.simulateBlocks.mock.calls[0][0].blocks[0].calls.map(
        (call: { nonce: number }) => call.nonce
      )
    ).toEqual([0, 1])
  })
  it("rejects failure of either transaction in the sequence", async () => {
    for (const failure of [0, 1]) {
      publicClientMock.simulateBlocks.mockResolvedValue([
        {
          calls: [0, 1].map((i) =>
            i === failure
              ? {
                  data: "0x",
                  error: new Error("reverted"),
                  gasUsed: 30000n,
                  status: "failure",
                }
              : { data: "0x", gasUsed: 30000n, status: "success" }
          ),
        },
      ])
      const sender = `0x${(10 + failure).toString(16).padStart(40, "0")}`
      await expect(
        buildEvmTransaction(tx(1, sender), [tx(0, sender)])
      ).rejects.toThrow("Sequential EVM simulation")
    }
  })
  it("does not use a different sender, RPC, or nonce gap as a prerequisite", async () => {
    const sender = "0x0000000000000000000000000000000000000004"
    for (const preceding of [
      tx(0, "0x0000000000000000000000000000000000000005"),
      { ...tx(0, sender), rpc: "https://example.com" },
      tx(2, sender),
    ]) {
      await expect(
        buildEvmTransaction(tx(1, sender), [preceding])
      ).rejects.toThrow("insufficient token balance")
    }
    expect(publicClientMock.simulateBlocks).not.toHaveBeenCalled()
  })
})

import { buildEvmTransaction, EthereumTxSchema } from "../src/builders/utils"

const loadMetisTx = () => {
  const raw = readFileSync(
    join(
      __dirname,
      "..",
      "transactions",
      "prod",
      "047-rt-migration-set-allocator.json"
    ),
    "utf8"
  )
  const data = JSON.parse(raw) as unknown[]
  const metis = data.find(
    (t): t is Record<string, unknown> =>
      typeof t === "object" &&
      t !== null &&
      (t as Record<string, unknown>).family === "ethereum-vm" &&
      typeof (t as Record<string, unknown>).rpc === "string" &&
      ((t as Record<string, unknown>).rpc as string).includes("metis")
  )
  if (!metis) throw new Error("No Metis transaction found in manifest 047")
  return EthereumTxSchema.parse(metis)
}

describe("buildEvmTransaction fee typing", () => {
  beforeEach(() => {
    publicClientMock.getChainId.mockResolvedValue(1088)
    publicClientMock.getTransactionCount.mockResolvedValue(2)
    publicClientMock.estimateGas.mockResolvedValue(29994n)
  })

  it("builds a legacy (type 0) transaction for a Metis tx with gasPrice", async () => {
    const tx = loadMetisTx()
    expect(tx.gasPrice).toBeDefined()
    expect(tx.maxFeePerGas).toBeUndefined()

    const { transaction, payload, hashesToSign } = await buildEvmTransaction(tx)

    // Only legacy fee fields should be present on the built transaction.
    expect(transaction.gasPrice).toBe(BigInt(tx.gasPrice!))
    expect(transaction.maxFeePerGas).toBeUndefined()
    expect(transaction.maxPriorityFeePerGas).toBeUndefined()

    // Legacy transactions are RLP-encoded with no type prefix, so the first
    // byte is >= 0xc0 (an RLP list) rather than 0x02 (EIP-1559 envelope).
    const firstByte = parseInt(payload.slice(2, 4), 16)
    expect(firstByte).toBeGreaterThanOrEqual(0xc0)

    // viem round-trips it as a legacy transaction.
    const parsed = parseTransaction(payload)
    expect(parsed.type).toBe("legacy")
    expect(parsed.gasPrice).toBe(BigInt(tx.gasPrice!))

    // The signed hash matches the keccak256 of the serialized legacy payload.
    expect(hashesToSign[0]).toBe(keccak256(payload))
  })

  it("builds an EIP-1559 (type 2) transaction when only maxFeePerGas is set", async () => {
    const tx = EthereumTxSchema.parse({
      amount: "0",
      calldata: "0x",
      family: "ethereum-vm",
      // Distinct sender so this case does not share the module-level
      // per-sender nonce offset with the Metis case above.
      from: "0x000000000000000000000000000000000000dEaD",
      gas: "21000",
      maxFeePerGas: "1000111",
      maxPriorityFeePerGas: "1000000",
      nonce: 2,
      rpc: "https://mainnet.base.org",
      to: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca",
    })

    const { transaction, payload } = await buildEvmTransaction(tx)

    expect(transaction.gasPrice).toBeUndefined()
    expect(transaction.maxFeePerGas).toBe(1000111n)

    // EIP-1559 transactions are prefixed with the 0x02 type byte.
    expect(payload.slice(0, 4)).toBe("0x02")
    expect(parseTransaction(payload).type).toBe("eip1559")
  })
})

describe("buildEvmTransaction nonce pre-check", () => {
  // Own sender so the module-level nonce tracker is not shared with the fee-typing cases.
  const withNonce = (nonce: number) => ({
    ...loadMetisTx(),
    from: "0x00000000000000000000000000000000000000A1",
    nonce,
  })

  beforeEach(() => {
    publicClientMock.getChainId.mockResolvedValue(1088)
    publicClientMock.estimateGas.mockResolvedValue(29994n)
  })

  it("accepts consecutive nonces when each tx is confirmed before the next", async () => {
    // Confirmed txs move the on-chain count, so the next manifest nonce equals it.
    publicClientMock.getTransactionCount.mockResolvedValueOnce(100)
    await buildEvmTransaction(withNonce(100))
    publicClientMock.getTransactionCount.mockResolvedValueOnce(101)
    await expect(buildEvmTransaction(withNonce(101))).resolves.toBeDefined()
  })

  it("accepts consecutive nonces when txs are fired without waiting", async () => {
    publicClientMock.getTransactionCount.mockResolvedValue(200)
    await buildEvmTransaction(withNonce(200))
    await expect(buildEvmTransaction(withNonce(201))).resolves.toBeDefined()
    await expect(buildEvmTransaction(withNonce(200))).rejects.toThrow(
      "Nonce too low"
    )
  })
})

describe("approval-only simulation skipping", () => {
  it("requires a different approval hash when an EIP-1559 fee cap changes", async () => {
    publicClientMock.getChainId.mockResolvedValueOnce(1088)
    const tx = {
      ...loadMetisTx(),
      from: "0x0000000000000000000000000000000000000093",
      gasPrice: undefined,
      maxFeePerGas: "24000000",
      maxPriorityFeePerGas: "0",
      nonce: 0,
    }
    const result = await buildEvmTransaction(tx, [], { skipSimulation: true })
    const repriced = serializeTransaction({
      ...result.transaction,
      maxFeePerGas: 25000000n,
    })
    expect(keccak256(repriced)).not.toBe(result.hashesToSign[0])
  })
  beforeEach(() => {
    publicClientMock.getChainId.mockResolvedValue(1088)
    publicClientMock.getTransactionCount.mockResolvedValue(0)
    publicClientMock.estimateGas
      .mockReset()
      .mockRejectedValue(new Error("awaiting withdrawal funds"))
    publicClientMock.simulateBlocks.mockReset()
  })

  it("constructs the exact transaction hash without executing an unfunded call", async () => {
    const tx = {
      ...loadMetisTx(),
      from: "0x0000000000000000000000000000000000000091",
      nonce: 0,
    }
    const result = await buildEvmTransaction(tx, [], { skipSimulation: true })
    expect(result.hashesToSign).toEqual([keccak256(result.payload)])
    expect(parseTransaction(result.payload)).toMatchObject({
      chainId: 1088,
      nonce: 0,
      to: tx.to.toLowerCase(),
    })
    expect(publicClientMock.estimateGas).not.toHaveBeenCalled()
    expect(publicClientMock.simulateBlocks).not.toHaveBeenCalled()
  })

  it("still rejects spent nonces, and simulates by default for execution", async () => {
    const tx = {
      ...loadMetisTx(),
      from: "0x0000000000000000000000000000000000000092",
      nonce: 0,
    }
    publicClientMock.getTransactionCount.mockResolvedValueOnce(1)
    await expect(
      buildEvmTransaction(tx, [], { skipSimulation: true })
    ).rejects.toThrow("Nonce too low")
    await expect(buildEvmTransaction(tx)).rejects.toThrow(
      "awaiting withdrawal funds"
    )
    expect(publicClientMock.estimateGas).toHaveBeenCalledOnce()
  })
})

describe("historical EVM verification", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    publicClientMock.getChainId.mockResolvedValue(1088)
    publicClientMock.getTransactionCount.mockResolvedValue(999)
    publicClientMock.estimateGas.mockRejectedValue(
      new Error("already executed")
    )
  })

  it("rebuilds an executed transaction without querying its nonce or simulating", async () => {
    const tx = loadMetisTx()
    const result = await buildEvmTransaction(tx, [], {
      skipEvmStateChecks: true,
    })
    expect(parseTransaction(result.payload)).toMatchObject({
      chainId: 1088,
      gasPrice: BigInt(tx.gasPrice!),
      nonce: tx.nonce,
      to: tx.to.toLowerCase(),
    })
    expect(result.hashesToSign).toEqual([keccak256(result.payload)])
    expect(publicClientMock.getChainId).toHaveBeenCalledOnce()
    expect(publicClientMock.getTransactionCount).not.toHaveBeenCalled()
    expect(publicClientMock.estimateGas).not.toHaveBeenCalled()
    expect(publicClientMock.simulateBlocks).not.toHaveBeenCalled()
  })

  it("still requires destination chain ID lookup for historical verification", async () => {
    publicClientMock.getChainId.mockRejectedValueOnce(
      new Error("RPC unavailable")
    )
    await expect(
      buildEvmTransaction(loadMetisTx(), [], { skipEvmStateChecks: true })
    ).rejects.toThrow("RPC unavailable")
    expect(publicClientMock.getTransactionCount).not.toHaveBeenCalled()
  })
})
