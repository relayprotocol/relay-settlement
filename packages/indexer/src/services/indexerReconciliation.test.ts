import assert from "node:assert/strict"
import test from "node:test"
import type { Contract } from "ethers"
import type { Database } from "../db/connection.js"
import type { IndexerAuditFinding } from "./indexerAudit.js"
import {
  enqueueBalanceDriftReconciliations,
  processPendingBalanceDriftReconciliations,
} from "./indexerReconciliation.js"

class FakeReconciliationDb {
  completed: Array<{ error: string | null; id: number; status: string }> = []
  enqueued: unknown[][] = []
  queries: string[] = []
  private claimRows: unknown[]

  constructor(options: { claimRows?: unknown[] } = {}) {
    this.claimRows = options.claimRows ?? []
  }

  result = async (query: string, params?: unknown[]) => {
    this.queries.push(query)
    if (query.includes("INSERT INTO indexer_reconciliation_jobs")) {
      this.enqueued.push(params ?? [])
      return { rowCount: 1 }
    }
    throw new Error(`Unexpected result query: ${query}`)
  }

  tx = async <T>(callback: (_tx: FakeReconciliationDb) => Promise<T>) =>
    callback(this)

  manyOrNone = async (query: string) => {
    this.queries.push(query)
    if (query.includes("UPDATE indexer_reconciliation_jobs jobs")) {
      return this.claimRows
    }
    return []
  }

  one = async (query: string, params?: unknown[]) => {
    this.queries.push(query)
    if (query.includes("SELECT COUNT(*)::int AS count FROM balances")) {
      return { count: 0 }
    }
    throw new Error(`Unexpected one query: ${query} ${String(params)}`)
  }

  oneOrNone = async (query: string, params?: unknown[]) => {
    this.queries.push(query)
    if (query.includes("SELECT token_id, name, symbol")) {
      return {
        decimals: 18,
        holders: 1,
        name: "Test token",
        symbol: null,
        token_id: params?.[0],
        total_supply: "10",
      }
    }
    if (query.includes("SELECT balance FROM balances")) {
      return { balance: "10" }
    }
    return null
  }

  none = async (query: string, params?: unknown[]) => {
    this.queries.push(query)
    if (query.includes("UPDATE indexer_reconciliation_jobs")) {
      this.completed.push({
        error: params?.[1] == null ? null : String(params[1]),
        id: Number(params?.[2]),
        status: String(params?.[0]),
      })
      return
    }
    if (
      query.includes("DELETE FROM balances") ||
      query.includes("UPDATE tokens SET total_supply")
    ) {
      return
    }
    throw new Error(`Unexpected none query: ${query}`)
  }
}

const balanceFinding = (
  overrides: Partial<IndexerAuditFinding> = {}
): IndexerAuditFinding => ({
  address: "0x0000000000000000000000000000000000000001",
  blockNumber: null,
  chainBalance: "0",
  classification: "confirmed",
  details: {},
  indexedBalance: "10",
  kind: "balance-drift",
  latestEventBlock: 20,
  logIndex: null,
  tokenId: "1",
  tokenName: "Test token",
  txHash: null,
  ...overrides,
})

test("enqueueBalanceDriftReconciliations only queues confirmed balance drift", async () => {
  const db = new FakeReconciliationDb() as unknown as Database

  const count = await enqueueBalanceDriftReconciliations(db, 42, [
    balanceFinding(),
    balanceFinding({ classification: "pending_head" }),
    balanceFinding({ address: null }),
    balanceFinding({
      address: null,
      blockNumber: 95,
      chainBalance: null,
      indexedBalance: null,
      kind: "transfer-coverage",
      logIndex: 1,
      tokenId: "1",
      txHash: "0xabc",
    }),
  ])

  const fakeDb = db as unknown as FakeReconciliationDb
  assert.equal(count, 1)
  assert.equal(fakeDb.enqueued.length, 1)
  assert.equal(fakeDb.enqueued[0][0], "balance-drift")
  assert.equal(fakeDb.enqueued[0][2], 42)
  assert.equal(fakeDb.enqueued[0][3], "1")
  assert.equal(
    fakeDb.enqueued[0][4],
    "0x0000000000000000000000000000000000000001"
  )
})

test("processPendingBalanceDriftReconciliations uses state-based reconciliation", async () => {
  const db = new FakeReconciliationDb({
    claimRows: [
      {
        address: "0x0000000000000000000000000000000000000001",
        attempt_count: 1,
        id: 7,
        kind: "balance-drift",
        source_audit_run_id: 42,
        token_id: "1",
      },
    ],
  }) as unknown as Database
  const contract = {
    balanceOf: async () => 0n,
    totalSupply: async () => 0n,
  } as unknown as Contract

  const result = await processPendingBalanceDriftReconciliations(db, contract, {
    limit: 10,
    staleAfterMs: 60_000,
  })

  const fakeDb = db as unknown as FakeReconciliationDb
  assert.deepEqual(result, {
    claimed: 1,
    failed: 0,
    succeeded: 1,
  })
  assert.deepEqual(fakeDb.completed, [
    {
      error: null,
      id: 7,
      status: "succeeded",
    },
  ])
  assert.equal(
    fakeDb.queries.some((query) => query.includes("INSERT INTO events")),
    false
  )
})
