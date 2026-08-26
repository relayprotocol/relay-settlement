import assert from "node:assert/strict"
import test from "node:test"
import { RelayHub } from "@relay-protocol/settlement-abis"
import { Interface, ZeroAddress } from "ethers"
import type { Contract, Provider } from "ethers"
import type { Database } from "../db/connection.js"
import {
  buildSuggestedReplayRanges,
  getIndexerAuditHealth,
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
