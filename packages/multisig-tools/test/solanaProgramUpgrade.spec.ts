import { createHash } from "crypto"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Command } from "commander"
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerSolanaProgramUpgrade } from "../src/commands/solana-program-upgrade"
import { BpfLoaderUpgradeableProgram } from "../src/commands/bpf-upgradeable-browser/bpf-upgradeable-browser"

vi.mock("@solana/web3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/web3.js")>()),
  sendAndConfirmTransaction: vi.fn(),
}))

describe("Solana program upgrade", () => {
  const programKeypair = Keypair.generate()
  const chainId = "solana-mainnet"
  const [depository] = PublicKey.findProgramAddressSync(
    [Buffer.from("relay_depository")],
    programKeypair.publicKey
  )
  let directory: string
  let data: Buffer | null
  let existing: boolean
  let programReads: number

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    directory = mkdtempSync(join(tmpdir(), "solana-upgrade-"))
    writeFileSync(join(directory, "initial.so"), Buffer.from([1]))
    writeFileSync(join(directory, "upgrade.so"), Buffer.from([2]))
    writeFileSync(
      join(directory, "program.json"),
      JSON.stringify(Array.from(programKeypair.secretKey))
    )
    existing = false
    programReads = 0
    data = Buffer.concat([
      createHash("sha256")
        .update("account:RelayDepository")
        .digest()
        .subarray(0, 8),
      Buffer.alloc(65),
      Buffer.from([1]),
      createHash("sha256")
        .update(
          Buffer.concat([
            Buffer.from(`RelayDepository1${chainId}`),
            programKeypair.publicKey.toBuffer(),
          ])
        )
        .digest(),
    ])
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation(
      async (key) => {
        if (key.equals(depository)) {
          return data
            ? {
                data,
                executable: false,
                lamports: 1,
                owner: programKeypair.publicKey,
                rentEpoch: 0,
              }
            : null
        }
        if (key.equals(programKeypair.publicKey)) {
          return existing || programReads++ > 0
            ? {
                data: Buffer.alloc(0),
                executable: true,
                lamports: 1,
                owner: BpfLoaderUpgradeableProgram.programId,
                rentEpoch: 0,
              }
            : null
        }
        throw new Error(`Unexpected account read: ${key.toBase58()}`)
      }
    )
    vi.spyOn(
      Connection.prototype,
      "getMinimumBalanceForRentExemption"
    ).mockResolvedValue(1)
    vi.mocked(sendAndConfirmTransaction).mockResolvedValue("signature")
    vi.spyOn(BpfLoaderUpgradeableProgram, "upgrade")
  })

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  const run = async () => {
    const command = new Command()
    registerSolanaProgramUpgrade(command)
    const outcome = command
      .parseAsync(
        [
          "solana-program-upgrade",
          "--rpc",
          "http://127.0.0.1:8899",
          "--chain-id",
          chainId,
          "--initial-program-path",
          join(directory, "initial.so"),
          "--upgrade-program-path",
          join(directory, "upgrade.so"),
          "--program-keypair",
          join(directory, "program.json"),
          "--buffer-authority",
          bs58.encode(Keypair.generate().secretKey),
        ],
        { from: "user" }
      )
      .then(
        () => undefined,
        (error: Error) => error
      )
    await vi.runAllTimersAsync()
    return outcome
  }

  it("initializes with chain ID before upgrading", async () => {
    expect(await run()).toBeUndefined()
    const instructions = vi
      .mocked(sendAndConfirmTransaction)
      .mock.calls.flatMap(([, transaction]) => transaction.instructions)
    const initialize = instructions.find((ix) =>
      ix.programId.equals(programKeypair.publicKey)
    )!
    expect(initialize.data.subarray(0, 8)).toEqual(
      createHash("sha256").update("global:initialize").digest().subarray(0, 8)
    )
    expect(initialize.data.readUInt32LE(8)).toBe(Buffer.byteLength(chainId))
    expect(initialize.data.subarray(12).toString("utf8")).toBe(chainId)
    expect(BpfLoaderUpgradeableProgram.upgrade).toHaveBeenCalledTimes(1)
  })

  it.each(["legacy", "unset", "truncated", "missing", "mismatched"])(
    "blocks the final upgrade with a %s separator",
    async (state) => {
      if (state === "legacy") data = data!.subarray(0, 73)
      if (state === "unset") data![73] = 0
      if (state === "truncated") data = data!.subarray(0, 80)
      if (state === "missing") data = null
      if (state === "mismatched") data![74] ^= 1

      expect(await run()).toMatchObject({
        message: expect.stringContaining(
          state === "mismatched"
            ? "does not match --chain-id"
            : "has no valid domain separator"
        ),
      })
      expect(BpfLoaderUpgradeableProgram.upgrade).not.toHaveBeenCalled()
    }
  )

  it("blocks existing legacy accounts before upgrading", async () => {
    existing = true
    data = data!.subarray(0, 73)
    expect(await run()).toMatchObject({
      message: expect.stringContaining("migrate the legacy account"),
    })
    expect(BpfLoaderUpgradeableProgram.upgrade).not.toHaveBeenCalled()
  })

  it("upgrades existing migrated accounts without initializing", async () => {
    existing = true
    expect(await run()).toBeUndefined()
    expect(BpfLoaderUpgradeableProgram.upgrade).toHaveBeenCalledTimes(2)
    const instructions = vi
      .mocked(sendAndConfirmTransaction)
      .mock.calls.flatMap(([, transaction]) => transaction.instructions)
    expect(
      instructions.some((ix) => ix.programId.equals(programKeypair.publicKey))
    ).toBe(false)
  })
})
