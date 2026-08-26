import { readFileSync } from "fs"
import { join } from "path"
import { keccak256, parseTransaction } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the network client so `buildEvmTransaction` can run without RPC access.
// Everything else (serialization, hashing) uses the real viem implementation.
const publicClientMock = {
  estimateGas: vi.fn(),
  getChainId: vi.fn(),
  getTransactionCount: vi.fn(),
}

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem")
  return {
    ...actual,
    createPublicClient: () => publicClientMock,
  }
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
