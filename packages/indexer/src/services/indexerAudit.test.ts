import assert from "node:assert/strict"
import test from "node:test"
import { RelayHub } from "@relay-protocol/settlement-abis"
import { Interface, ZeroAddress } from "ethers"
import type { Contract, Provider } from "ethers"
import type { Database } from "../db/connection.js"
import {
  buildSuggestedReplayRanges,
  getIndexerAuditHealth,
  getLatestIndexerAuditReport,
  mergeSuggestedReplayRanges,
  runTransferCoverageAudit,
} from "./indexerAudit.js"

const relayHubInterface = new Interface(RelayHub)
const transferEvent = relayHubInterface.getEvent("Transfer")

if (!transferEvent) {
  throw new Error("Transfer event not found")
}

class FakeAuditDb {
  findings: unknown[][] = []
  runId = 0
  updates: unknown[][] = []
  queries: string[] = []
  private options: {
    eventRows?: unknown[]
    latestRuns?: unknown[]
    metaValue?: string
    recentRuns?: Record<string, unknown[]>
    tokenRows?: unknown[]
  }

  constructor(options: FakeAuditDb["options"]) {
    this.options = options
  }

  one = async (query: string) => {
    if (query.includes("INSERT INTO indexer_audit_runs")) {
      this.runId += 1
      return { id: this.runId }
    }
    throw new Error(`Unexpected one query: ${query}`)
  }

  oneOrNone = async () => {
    return { value: this.options.metaValue ?? "100" }
  }

  manyOrNone = async (query: string, params?: unknown[]) => {
    this.queries.push(query)
    if (query.includes("FROM events") && query.includes("unnest")) {
      return this.options.eventRows ?? []
    }
    if (query.includes("FROM tokens")) {
      return this.options.tokenRows ?? []
    }
    if (query.includes("DISTINCT ON")) {
      return this.options.latestRuns ?? []
    }
    if (query.includes("WHERE kind = $1")) {
      return this.options.recentRuns?.[String(params?.[0])] ?? []
    }
    return []
  }

  none = async (query: string, params?: unknown[]) => {
    if (query.includes("UPDATE indexer_audit_runs"))
      this.updates.push(params ?? [])
    if (query.includes("INSERT INTO indexer_audit_findings")) {
      this.findings.push(params ?? [])
    }
  }
}

const makeTransferLog = (
  blockNumber: number,
  logIndex: number,
  transfer: {
    amount: bigint
    from: string
    operator: string
    to: string
    tokenId: bigint
  }
) => {
  const encoded = relayHubInterface.encodeEventLog(transferEvent, [
    transfer.operator,
    transfer.from,
    transfer.to,
    transfer.tokenId,
    transfer.amount,
  ])

  return {
    blockNumber,
    data: encoded.data,
    index: logIndex,
    topics: encoded.topics,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
  }
}

test("buildSuggestedReplayRanges pads, merges, sorts, and caps ranges", () => {
  assert.deepEqual(
    buildSuggestedReplayRanges([200, 100, 225], {
      maxRange: 100,
      padding: 25,
      reason: "transfer-coverage",
    }),
    [
      {
        findingCount: 1,
        fromBlock: 75,
        reason: "transfer-coverage",
        toBlock: 125,
      },
      {
        findingCount: 2,
        fromBlock: 175,
        reason: "transfer-coverage",
        toBlock: 250,
      },
    ]
  )

  assert.deepEqual(
    mergeSuggestedReplayRanges(
      [
        {
          findingCount: 1,
          fromBlock: 0,
          reason: "transfer-coverage",
          toBlock: 250,
        },
      ],
      100
    ).map(({ fromBlock, toBlock }) => ({ fromBlock, toBlock })),
    [
      { fromBlock: 0, toBlock: 99 },
      { fromBlock: 100, toBlock: 199 },
      { fromBlock: 200, toBlock: 250 },
    ]
  )
})

test("runTransferCoverageAudit records a missing hub transfer log", async () => {
  const tokenId = 1n
  const log = makeTransferLog(95, 4, {
    amount: 10n,
    from: ZeroAddress,
    operator: "0x0000000000000000000000000000000000000003",
    to: "0x0000000000000000000000000000000000000001",
    tokenId,
  })
  const fakeDb = new FakeAuditDb({
    eventRows: [],
    tokenRows: [{ name: "Test token", token_id: tokenId.toString() }],
  })
  const db = fakeDb as unknown as Database
  const provider = {
    getBlockNumber: async () => 120,
    getLogs: async () => [log],
  } as unknown as Provider
  const hubContract = {
    target: "0x0000000000000000000000000000000000000002",
  } as unknown as Contract

  const result = await runTransferCoverageAudit(db, provider, hubContract, {
    lookbackBlocks: 20,
    maxReplayRange: 100,
    replayPaddingBlocks: 5,
  })

  assert.equal(result.checkedCount, 1)
  assert.equal(result.confirmedCount, 1)
  assert.equal(fakeDb.findings[0][5], 95)
  assert.equal(fakeDb.findings[0][2], "confirmed")
})

test("getIndexerAuditHealth fails after consecutive confirmed findings", async () => {
  const now = new Date("2026-06-06T12:00:00.000Z")
  const run = (id: number, kind: string, confirmedCount: number) => ({
    audit_block: 100,
    checked_count: 10,
    completed_at: now.toISOString(),
    confirmed_count: confirmedCount,
    error: null,
    id,
    kind,
    latest_chain_block: 112,
    started_at: now.toISOString(),
    status: "succeeded",
  })
  const db = new FakeAuditDb({
    latestRuns: [run(4, "transfer-coverage", 1)],
    recentRuns: {
      "transfer-coverage": [
        run(4, "transfer-coverage", 1),
        run(3, "transfer-coverage", 1),
      ],
    },
  }) as unknown as Database

  const health = await getIndexerAuditHealth(db, {
    consecutiveFailures: 2,
    failureThreshold: 1,
    maxAgeMs: 30 * 60 * 1000,
    now,
  })

  assert.equal(health.ok, false)
  assert.equal(health.kinds[0].ok, false)
  assert.equal(
    health.kinds[0].reason,
    "confirmed audit findings exceeded threshold"
  )
})

test("getIndexerAuditHealth does not fail without confirmed findings", async () => {
  const now = new Date("2026-06-06T12:00:00.000Z")
  const run = (id: number, kind: string, confirmedCount: number) => ({
    audit_block: 100,
    checked_count: 10,
    completed_at: now.toISOString(),
    confirmed_count: confirmedCount,
    error: null,
    id,
    kind,
    latest_chain_block: 112,
    started_at: now.toISOString(),
    status: "succeeded",
  })
  const db = new FakeAuditDb({
    latestRuns: [run(4, "transfer-coverage", 0)],
    recentRuns: {
      "transfer-coverage": [
        run(4, "transfer-coverage", 0),
        run(3, "transfer-coverage", 0),
      ],
    },
  }) as unknown as Database

  const health = await getIndexerAuditHealth(db, {
    consecutiveFailures: 2,
    failureThreshold: 1,
    maxAgeMs: 30 * 60 * 1000,
    now,
  })

  assert.equal(health.ok, true)
  assert.equal(health.kinds[0].ok, true)
})

const auditOptions = {
  auditBlock: 100,
  latestChainBlock: 112,
  lookbackBlocks: 100,
  maxReplayRange: 1000,
  replayPaddingBlocks: 5,
}
const auditHub = {
  target: "0x0000000000000000000000000000000000000002",
} as unknown as Contract
const auditLog = (index: number, tokenId = 1n) =>
  makeTransferLog(100, index, {
    amount: 10n,
    from: ZeroAddress,
    operator: ZeroAddress,
    to: "0x0000000000000000000000000000000000000001",
    tokenId,
  })

test("coverage preserves excluded/malformed semantics for both indexed and missing events", async () => {
  const excludedId =
    645919125454048919867832098713637349341491234231283657783660937934976435626n
  const logs = [
    auditLog(0),
    auditLog(1),
    auditLog(2, excludedId),
    auditLog(3, excludedId),
    { ...auditLog(4), data: "0x" },
    { ...auditLog(5), data: "0x" },
  ]
  const db = new FakeAuditDb({
    eventRows: [logs[0], logs[2], logs[4]].map((log) => ({
      log_index: log.index,
      tx_hash: log.transactionHash,
    })),
  })
  const provider = { getLogs: async () => logs } as unknown as Provider
  const result = await runTransferCoverageAudit(
    db as unknown as Database,
    provider,
    auditHub,
    auditOptions
  )
  assert.equal(result.checkedCount, 2)
  assert.equal(result.confirmedCount, 1)
  assert.equal(db.findings.length, 1)
  assert.equal(db.findings[0][7], 1)
})

test("large covered audits yield and look up only bounded pages of identities", async () => {
  const size = 244130
  const base = auditLog(0)
  let maxLookup = 0
  let lookups = 0
  const db = new FakeAuditDb({})
  db.manyOrNone = async (query, params) => {
    if (!query.includes("FROM events")) return []
    const hashes = params?.[0] as string[]
    const indices = params?.[1] as number[]
    maxLookup = Math.max(maxLookup, hashes.length)
    lookups++
    return hashes.map((tx_hash, index) => ({
      log_index: indices[index],
      tx_hash,
    }))
  }
  const provider = {
    getLogs: async () => {
      throw Object.assign(new Error("Response size exceeds limit"), {
        code: -32005,
      })
    },
    send: async (_method: string, [filter]: [{ cursor?: string }]) => {
      const start = Number(filter.cursor ?? 0)
      const end = Math.min(start + 1000, size)
      return {
        cursor: end < size ? String(end) : null,
        logs: Array.from({ length: end - start }, (_, i) => ({
          ...base,
          index: start + i,
        })),
      }
    },
  } as unknown as Provider
  let ticks = 0
  let handle: NodeJS.Immediate
  const beat = () => {
    ticks++
    handle = setImmediate(beat)
  }
  handle = setImmediate(beat)
  try {
    const result = await runTransferCoverageAudit(
      db as unknown as Database,
      provider,
      auditHub,
      { ...auditOptions, lookbackBlocks: 1 }
    )
    assert.equal(result.checkedCount, size)
    assert.equal(result.confirmedCount, 0)
    assert.ok(maxLookup <= 1000)
    assert.equal(lookups, Math.ceil(size / 1000))
    assert.ok(ticks >= Math.floor(size / 100), `only ${ticks} scheduler turns`)
  } finally {
    clearImmediate(handle)
  }
})

test("missing findings persist before the next cursor fetch and incomplete audits fail", async () => {
  const db = new FakeAuditDb({})
  let calls = 0
  const provider = {
    getLogs: async () => {
      throw Object.assign(new Error("Response size exceeds limit"), {
        code: -32005,
      })
    },
    send: async () => {
      if (++calls === 2) {
        assert.equal(db.findings.length, 3)
        throw new Error("cursor unavailable")
      }
      return { cursor: "next", logs: [auditLog(0), auditLog(1), auditLog(2)] }
    },
  } as unknown as Provider
  await assert.rejects(
    runTransferCoverageAudit(db as unknown as Database, provider, auditHub, {
      ...auditOptions,
      lookbackBlocks: 1,
    }),
    /cursor unavailable/
  )
  assert.equal(db.updates[db.updates.length - 1]?.[0], "failed")
})

test("partial findings from failed audits are excluded from the report", async () => {
  const now = new Date().toISOString()
  const db = new FakeAuditDb({
    latestRuns: [
      {
        audit_block: null,
        checked_count: 0,
        completed_at: now,
        confirmed_count: 0,
        error: "RPC failed",
        id: 1,
        kind: "transfer-coverage",
        latest_chain_block: null,
        started_at: now,
        status: "failed",
      },
    ],
  })
  const report = await getLatestIndexerAuditReport(db as unknown as Database, {
    consecutiveFailures: 2,
    failureThreshold: 1,
    maxAgeMs: 60000,
    maxReplayRange: 1000,
  })
  assert.equal(report.ok, false)
  assert.deepEqual(report.findings, [])
  assert.ok(
    !db.queries.some((query) => query.includes("FROM indexer_audit_findings"))
  )
})
