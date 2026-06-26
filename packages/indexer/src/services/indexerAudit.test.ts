import assert from "node:assert/strict"
import test from "node:test"
import { RelayHub } from "@relay-protocol/settlement-abis"
import { Interface, ZeroAddress } from "ethers"
import type { Contract, Provider } from "ethers"
import type { Database } from "../db/connection.js"
import {
  buildSuggestedReplayRanges,
  classifyBalanceDrift,
  getIndexerAuditHealth,
  mergeSuggestedReplayRanges,
  runBalanceDriftAudit,
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
  private options: {
    balanceRows?: unknown[]
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
    if (query.includes("FROM balances b")) {
      return this.options.balanceRows ?? []
    }
    if (query.includes("FROM events") && query.includes("BETWEEN")) {
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

test("classifyBalanceDrift flags confirmed and pending mismatches", () => {
  assert.equal(
    classifyBalanceDrift({
      auditBlock: 1000,
      chainBalance: "0",
      graceBlocks: 250,
      indexedBalance: "10",
      latestEventBlock: 700,
    }),
    "confirmed"
  )

  assert.equal(
    classifyBalanceDrift({
      auditBlock: 1000,
      chainBalance: "0",
      graceBlocks: 250,
      indexedBalance: "10",
      latestEventBlock: 990,
    }),
    "pending_head"
  )

  assert.equal(
    classifyBalanceDrift({
      auditBlock: 1000,
      chainBalance: "0",
      chainLatestBalance: "10",
      graceBlocks: 250,
      indexedBalance: "10",
      latestEventBlock: 700,
    }),
    "ahead_of_checkpoint"
  )
})

test("buildSuggestedReplayRanges pads, merges, sorts, and caps ranges", () => {
  assert.deepEqual(
    buildSuggestedReplayRanges([200, 100, 225], {
      maxRange: 100,
      padding: 25,
      reason: "balance-drift",
    }),
    [
      {
        findingCount: 1,
        fromBlock: 75,
        reason: "balance-drift",
        toBlock: 125,
      },
      {
        findingCount: 2,
        fromBlock: 175,
        reason: "balance-drift",
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
          reason: "balance-drift",
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

test("runBalanceDriftAudit records a confirmed stale balance", async () => {
  const fakeDb = new FakeAuditDb({
    balanceRows: [
      {
        address: "0x0000000000000000000000000000000000000001",
        balance: "10",
        latest_event_block: 20,
        token_id: "1",
        token_name: "Test token",
      },
    ],
  })
  const db = fakeDb as unknown as Database

  const provider = {
    getBlockNumber: async () => 120,
    getLogs: async () => [],
  } as unknown as Provider
  const hubContract = {
    balanceOf: async () => 0n,
    target: "0x0000000000000000000000000000000000000002",
  } as unknown as Contract

  const result = await runBalanceDriftAudit(db, provider, hubContract, {
    batchSize: 10,
    graceBlocks: 10,
    maxReplayRange: 100,
    replayPaddingBlocks: 5,
  })

  assert.equal(result.checkedCount, 1)
  assert.equal(result.confirmedCount, 1)
  assert.equal(result.findings[0].classification, "confirmed")
  assert.equal(result.findings[0].chainBalance, "0")
  assert.equal(fakeDb.findings.length, 1)
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
  const db = new FakeAuditDb({
    eventRows: [],
    tokenRows: [{ name: "Test token", token_id: tokenId.toString() }],
  }) as unknown as Database
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
  assert.equal(result.findings[0].blockNumber, 95)
  assert.equal(result.findings[0].classification, "confirmed")
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
    pending_count: 0,
    started_at: now.toISOString(),
    status: "succeeded",
  })
  const db = new FakeAuditDb({
    latestRuns: [run(2, "balance-drift", 1), run(4, "transfer-coverage", 0)],
    recentRuns: {
      "balance-drift": [run(2, "balance-drift", 1), run(1, "balance-drift", 1)],
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

  assert.equal(health.ok, false)
  assert.equal(health.kinds[0].ok, false)
  assert.equal(
    health.kinds[0].reason,
    "confirmed audit findings exceeded threshold"
  )
})

test("getIndexerAuditHealth does not fail on pending-only findings", async () => {
  const now = new Date("2026-06-06T12:00:00.000Z")
  const run = (
    id: number,
    kind: string,
    confirmedCount: number,
    pendingCount: number
  ) => ({
    audit_block: 100,
    checked_count: 10,
    completed_at: now.toISOString(),
    confirmed_count: confirmedCount,
    error: null,
    id,
    kind,
    latest_chain_block: 112,
    pending_count: pendingCount,
    started_at: now.toISOString(),
    status: "succeeded",
  })
  const db = new FakeAuditDb({
    latestRuns: [
      run(2, "balance-drift", 0, 3),
      run(4, "transfer-coverage", 0, 0),
    ],
    recentRuns: {
      "balance-drift": [
        run(2, "balance-drift", 0, 3),
        run(1, "balance-drift", 0, 2),
      ],
      "transfer-coverage": [
        run(4, "transfer-coverage", 0, 0),
        run(3, "transfer-coverage", 0, 0),
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
  assert.equal(health.kinds[0].pendingCount, 3)
})
