// ABOUTME: Detects sibling manifests that claim the same EVM nonce slot as the
// ABOUTME: manifest being submitted, so two pending Safe proposals can't race
// ABOUTME: for one (signer, chain, nonce) and leave the loser unexecutable.
//
// The on-chain nonce check in `buildEvmTransaction` only sees slots that are
// already spent. Two manifests written against the same starting nonce both
// pass that check while both are pending — whichever Safe transaction executes
// first burns the nonce, and the other manifest silently becomes dead. That is
// exactly how the INC-13 recovery batch was invalidated by an unrelated config
// batch sharing nonces 117-118.
import { readdirSync, readFileSync } from "fs"
import { basename, dirname, join, resolve } from "path"
import { createPublicClient, http } from "viem"
import type { z } from "zod"
import { EthereumTxSchema, TransactionsSchema } from "../builders/utils"

type EthereumTx = z.infer<typeof EthereumTxSchema>

export type NonceConflict = {
  from: `0x${string}`
  manifest: string
  nonce: number
  rpc: string
}

// Conflict detection must never hang a submission on an unresponsive RPC, so
// these probes fail fast instead of using the default retry behaviour.
const RPC_TIMEOUT_MS = 5_000

const clientFor = (rpc: string) =>
  createPublicClient({
    transport: http(rpc, { retryCount: 0, timeout: RPC_TIMEOUT_MS }),
  })

const chainIdCache = new Map<string, Promise<number | undefined>>()

const chainIdOf = (rpc: string) => {
  let pending = chainIdCache.get(rpc)
  if (!pending) {
    pending = clientFor(rpc)
      .getChainId()
      .catch(() => undefined)
    chainIdCache.set(rpc, pending)
  }
  return pending
}

// Two transactions only contend for the same nonce if they run on the same
// chain. Identical RPC URLs settle that without a round trip; otherwise both
// chain ids are resolved, and an unreachable RPC counts as "not proven to
// conflict" rather than blocking the submission.
const sameChain = async (a: string, b: string) => {
  if (a === b) return true
  const [chainA, chainB] = await Promise.all([chainIdOf(a), chainIdOf(b)])
  return chainA !== undefined && chainA === chainB
}

const slotKey = (from: string, nonce: number) =>
  `${from.toLowerCase()}:${nonce}`

// A manifest that fails to parse can't be reasoned about, and a sibling that
// isn't a valid manifest can't claim a nonce — either way there is nothing to
// compare. The strict parse still happens in `createTransactionBundle`.
const readEvmTransactions = (path: string): EthereumTx[] => {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return []
  }
  const parsed = TransactionsSchema.safeParse(data)
  if (!parsed.success) return []
  return parsed.data.filter(
    (tx): tx is EthereumTx => tx.family === "ethereum-vm"
  )
}

const siblingManifests = (path: string) =>
  readdirSync(dirname(path))
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dirname(path), name))
    .filter((sibling) => sibling !== path)
    .sort()

/// Returns every still-open nonce slot in `manifestPath` that another manifest
/// in the same directory also claims.
export const findNonceConflicts = async (
  manifestPath: string
): Promise<NonceConflict[]> => {
  const path = resolve(manifestPath)
  const transactions = readEvmTransactions(path)
  if (transactions.length === 0) return []

  const currentNonces = new Map<string, number | undefined>()
  for (const tx of transactions) {
    const key = `${tx.rpc}:${tx.from.toLowerCase()}`
    if (currentNonces.has(key)) continue
    currentNonces.set(
      key,
      await clientFor(tx.rpc)
        .getTransactionCount({ address: tx.from })
        .catch(() => undefined)
    )
  }

  // A slot that is already spent makes our own transaction unexecutable, which
  // `buildEvmTransaction` reports with a clearer error. Only slots still up for
  // grabs can be raced for.
  const openSlots = new Map<string, EthereumTx>()
  for (const tx of transactions) {
    const current = currentNonces.get(`${tx.rpc}:${tx.from.toLowerCase()}`)
    if (current === undefined || tx.nonce < current) continue
    openSlots.set(slotKey(tx.from, tx.nonce), tx)
  }
  if (openSlots.size === 0) return []

  const conflicts: NonceConflict[] = []
  for (const sibling of siblingManifests(path)) {
    for (const tx of readEvmTransactions(sibling)) {
      const own = openSlots.get(slotKey(tx.from, tx.nonce))
      if (!own) continue
      if (!(await sameChain(own.rpc, tx.rpc))) continue
      conflicts.push({
        from: tx.from,
        manifest: basename(sibling),
        nonce: tx.nonce,
        rpc: tx.rpc,
      })
    }
  }
  return conflicts
}

export const describeNonceConflicts = (conflicts: NonceConflict[]) =>
  conflicts
    .map(
      (conflict) =>
        `   • nonce ${conflict.nonce} for ${conflict.from} is also claimed by ${conflict.manifest}`
    )
    .join("\n")
