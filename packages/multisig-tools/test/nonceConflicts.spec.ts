import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Chain ids and current nonces are keyed by RPC URL so a manifest can be
// spread across chains without any network access.
const chainIdByRpc: Record<string, number> = {}
const nonceByRpc: Record<string, number> = {}

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem")
  return {
    ...actual,
    createPublicClient: ({ transport }: { transport: { rpc: string } }) => ({
      getChainId: async () => {
        const chainId = chainIdByRpc[transport.rpc]
        if (chainId === undefined) throw new Error("unreachable")
        return chainId
      },
      getTransactionCount: async () => nonceByRpc[transport.rpc] ?? 0,
    }),
    http: (rpc: string) => ({ rpc }),
  }
})

import { findNonceConflicts } from "../src/helpers/nonceConflicts"

const SIGNER = "0xF61A305199fa1135d76FFaB3752D42F55cBd775A"
const HUB = "0xDDD361727C22A01EB137880678A20b0BEaE69318"
const RELAY_RPC = "https://rpc.chain.relay.link"
const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc"

const tx = (nonce: number, rpc = RELAY_RPC, from = SIGNER) => ({
  amount: "0",
  calldata: "0xfe99049a",
  family: "ethereum-vm",
  from,
  gas: "2207463",
  maxFeePerGas: "7",
  maxPriorityFeePerGas: "0",
  nonce,
  rpc,
  to: HUB,
})

let dir: string

const writeManifest = (name: string, transactions: unknown[]) => {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(transactions, null, 2))
  return path
}

describe("findNonceConflicts", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "manifests-"))
    chainIdByRpc[RELAY_RPC] = 537713
    chainIdByRpc[ARBITRUM_RPC] = 42161
    nonceByRpc[RELAY_RPC] = 117
    nonceByRpc[ARBITRUM_RPC] = 4
  })

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true })
    vi.clearAllMocks()
  })

  it("flags a sibling manifest claiming the same open nonce slot", async () => {
    writeManifest("066-configure-gateway.json", [tx(117), tx(118)])
    const path = writeManifest("066-inc13-recovery.json", [
      tx(117),
      tx(118),
      tx(119),
    ])

    const conflicts = await findNonceConflicts(path)

    expect(conflicts).toEqual([
      {
        from: SIGNER,
        manifest: "066-configure-gateway.json",
        nonce: 117,
        rpc: RELAY_RPC,
      },
      {
        from: SIGNER,
        manifest: "066-configure-gateway.json",
        nonce: 118,
        rpc: RELAY_RPC,
      },
    ])
  })

  it("returns nothing once the manifest is regenerated past the conflict", async () => {
    writeManifest("066-configure-gateway.json", [tx(117), tx(118)])
    // The gateway batch executed, moving the signer's nonce to 119.
    nonceByRpc[RELAY_RPC] = 119
    const path = writeManifest("067-inc13-recovery.json", [tx(119), tx(120)])

    expect(await findNonceConflicts(path)).toEqual([])
  })

  it("ignores slots that are already spent", async () => {
    // Both manifests claim nonce 0, but the signer is long past it — that is a
    // nonce-too-low error, not a race between two pending proposals.
    nonceByRpc[RELAY_RPC] = 42
    writeManifest("020-handover.json", [tx(0)])
    const path = writeManifest("021-handover-retry.json", [tx(0)])

    expect(await findNonceConflicts(path)).toEqual([])
  })

  it("ignores the same signer and nonce on a different chain", async () => {
    writeManifest("047-set-allocator.json", [tx(4, ARBITRUM_RPC)])
    const path = writeManifest("048-set-allocator.json", [tx(4, RELAY_RPC)])

    expect(await findNonceConflicts(path)).toEqual([])
  })

  it("matches the same chain reached through a different RPC URL", async () => {
    const mirror = "https://relay-chain.example/rpc"
    chainIdByRpc[mirror] = 537713
    nonceByRpc[mirror] = 117
    writeManifest("065-other.json", [tx(117, mirror)])
    const path = writeManifest("066-inc13-recovery.json", [tx(117)])

    expect(await findNonceConflicts(path)).toMatchObject([
      { manifest: "065-other.json", nonce: 117 },
    ])
  })

  it("does not flag the manifest against itself", async () => {
    const path = writeManifest("066-inc13-recovery.json", [tx(117), tx(118)])

    expect(await findNonceConflicts(path)).toEqual([])
  })

  it("skips siblings that are not valid manifests", async () => {
    writeManifest("notes.json", [{ hello: "world" }])
    writeFileSync(join(dir, "broken.json"), "{ not json")
    const path = writeManifest("066-inc13-recovery.json", [tx(117)])

    expect(await findNonceConflicts(path)).toEqual([])
  })

  it("ignores non-EVM entries", async () => {
    writeManifest("050-solana.json", [
      {
        family: "solana-vm",
        from: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        instructions: [],
        rpc: "https://api.mainnet-beta.solana.com",
      },
    ])
    const path = writeManifest("066-inc13-recovery.json", [tx(117)])

    expect(await findNonceConflicts(path)).toEqual([])
  })
})
