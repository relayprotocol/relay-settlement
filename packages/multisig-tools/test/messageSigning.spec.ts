import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Command } from "commander"
import { decodeFunctionData, hashMessage } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { RelayMultisigSigner } from "@relay-protocol/settlement-abis"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildMessage,
  createTransactionBundle,
  getSignatureForHash,
  hasEvmTransactionBeenExecuted,
  buildEvmTransaction,
  MessageSchema,
  type Transaction,
} from "../src/builders/utils"
import {
  signMessageEntry,
  verifyMessageSignature,
} from "../src/helpers/messageSigning"
import { registerExecuteTransactions } from "../src/commands/execute-transactions"
import { executionIndices } from "../src/helpers/executionIndices"
import { checkAndApproveWNEAR } from "../src/helpers/wnear"
import type { ResolvedNetwork } from "../src/helpers/network"

const rpc = vi.hoisted(() => ({ getBlock: vi.fn() }))
vi.mock("viem", async () => ({
  ...(await vi.importActual("viem")),
  createPublicClient: () => rpc,
}))
vi.mock("../src/builders/utils", async () => ({
  ...(await vi.importActual("../src/builders/utils")),
  buildEvmTransaction: vi.fn(),
  getSignatureForHash: vi.fn(),
  hasEvmTransactionBeenExecuted: vi.fn(),
}))
vi.mock("../src/helpers/wnear", () => ({ checkAndApproveWNEAR: vi.fn() }))
vi.mock("../src/helpers/network", async () => ({
  ...(await vi.importActual("../src/helpers/network")),
  resolveNetwork: () => ({
    chainId: 1313161554,
    multisigSignerAddress: "0x0000000000000000000000000000000000000001",
    publicClient: {},
    walletClient: {
      account: { address: "0x0000000000000000000000000000000000000002" },
    },
  }),
}))
const account = privateKeyToAccount(`0x${"11".repeat(32)}`)
const signerContract = "0x0000000000000000000000000000000000000001"
const clients = {} as ResolvedNetwork
const personal: Extract<Transaction, { family: "message" }> = {
  description: "Withdrawal authorization",
  family: "message",
  from: account.address,
  message: { data: `0x${"ab".repeat(32)}`, type: "personal_sign" },
}
const regular: Extract<Transaction, { family: "ethereum-vm" }> = {
  amount: "0.2",
  calldata: "0x",
  family: "ethereum-vm",
  from: account.address,
  gas: "100000",
  maxFeePerGas: "24000000",
  maxPriorityFeePerGas: "0",
  nonce: 3,
  rpc: "https://mainnet.base.org",
  to: signerContract,
}

describe("sign-only messages and staged execution", () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "message-signing-"))
    vi.clearAllMocks()
    vi.mocked(getSignatureForHash).mockImplementation(async (_, hash) =>
      account.sign({ hash: hash as `0x${string}` })
    )
    vi.mocked(hasEvmTransactionBeenExecuted).mockResolvedValue(true)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })
  const command = () => {
    const program = new Command()
    registerExecuteTransactions(program)
    return program
  }
  const args = (path: string) => [
    "execute-transactions",
    "--transactions",
    path,
    "--env",
    "prod",
    "--network",
    "aurora",
  ]

  it("hashes raw bytes with EIP-191, not their hex text", () => {
    const result = buildMessage(personal)
    expect(result.hashesToSign[0]).toBe(hashMessage({ raw: result.payload }))
    expect(result.hashesToSign[0]).not.toBe(hashMessage(result.payload))
  })

  it("builds the standard Safe approval without signing", async () => {
    const path = join(directory, "messages.json")
    writeFileSync(path, JSON.stringify([personal]))
    const approvals = await createTransactionBundle(path, signerContract)
    expect(
      decodeFunctionData({ abi: RelayMultisigSigner, data: approvals[0].data })
        .args
    ).toEqual([buildMessage(personal).hashesToSign[0], "Ecdsa"])
    expect(getSignatureForHash).not.toHaveBeenCalled()
  })

  it("verifies the expected signer and rejects a signature for different bytes", async () => {
    const result = await signMessageEntry(personal, signerContract, clients)
    expect(result).not.toHaveProperty("serializedTransaction")
    await expect(
      verifyMessageSignature(
        { ...personal, message: { data: "0x1234", type: "personal_sign" } },
        result.signature
      )
    ).rejects.toThrow("expected signer")
  })

  it("rejects odd bytes, raw digests, and sign-only EIP-1559 transactions", () => {
    for (const message of [
      { data: "0x1", type: "personal_sign" },
      { data: "0x1234", type: "raw" },
      { chainId: 1, transaction: regular, type: "eip1559" },
    ])
      expect(MessageSchema.safeParse({ ...personal, message }).success).toBe(
        false
      )
  })

  it("selects mint and withdrawal without touching the bridge and preserves index 1", async () => {
    const path = join(directory, "recovery.json")
    const output = join(directory, "signatures.json")
    const mint = {
      ...regular,
      amount: "0",
      nonce: 199,
      rpc: "https://rpc.chain.relay.link",
    }
    writeFileSync(path, JSON.stringify([mint, personal, regular]))
    await command().parseAsync(
      [...args(path), "--indices", "0,1", "--signatures-output", output],
      { from: "user" }
    )
    expect(hasEvmTransactionBeenExecuted).toHaveBeenCalledTimes(1)
    expect(hasEvmTransactionBeenExecuted).toHaveBeenCalledWith(mint)
    expect(buildEvmTransaction).not.toHaveBeenCalled()
    const artifacts = JSON.parse(readFileSync(output, "utf8"))
    expect(artifacts.map((item: { index: number }) => item.index)).toEqual([1])
    expect(artifacts[0]).not.toHaveProperty("serializedTransaction")
    expect(getSignatureForHash).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    await command().parseAsync([...args(path), "--indices", "2"], {
      from: "user",
    })
    expect(hasEvmTransactionBeenExecuted).toHaveBeenCalledWith(regular)
    expect(getSignatureForHash).not.toHaveBeenCalled()
  })

  it("refuses invalid selections before any funding or signing", async () => {
    expect(executionIndices(3, "2,0")).toEqual([0, 2])
    for (const selection of ["", "-1", "1,1", "3", "1.5", "1,x"])
      expect(() => executionIndices(3, selection)).toThrow()
  })

  it("requires a fresh artifact path before funding or signing", async () => {
    const path = join(directory, "messages.json")
    writeFileSync(path, JSON.stringify([personal]))
    for (const extra of [[], ["--signatures-output", path]]) {
      await expect(
        command().parseAsync([...args(path), ...extra], { from: "user" })
      ).rejects.toThrow()
    }
    expect(checkAndApproveWNEAR).not.toHaveBeenCalled()
    expect(getSignatureForHash).not.toHaveBeenCalled()
  })

  it("rejects a stale fee cap before requesting an MPC signature even with FORCE_BROADCAST=1", async () => {
    vi.stubEnv("FORCE_BROADCAST", "1")
    const path = join(directory, "bridge.json")
    writeFileSync(path, JSON.stringify([regular]))
    vi.mocked(hasEvmTransactionBeenExecuted).mockResolvedValueOnce(false)
    vi.mocked(buildEvmTransaction).mockResolvedValueOnce({
      hashesToSign: [`0x${"01".repeat(32)}`],
      payload: "0x",
      transaction: { maxFeePerGas: 24000000n },
    })
    rpc.getBlock.mockResolvedValueOnce({ baseFeePerGas: 25000000n })
    await command().parseAsync(args(path), { from: "user" })
    expect(getSignatureForHash).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("new Safe approval and MPC signature")
    )
  })
})
