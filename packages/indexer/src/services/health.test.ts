import assert from "node:assert/strict"
import test from "node:test"

process.env.RPC_WS_URL ??= "ws://127.0.0.1:8545"
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@127.0.0.1:5432/relay_settlement_indexer_test"
process.env.HUB_CONTRACT_ADDRESS ??=
  "0xDDD361727C22A01EB137880678A20b0BEaE69318"
process.env.ORACLE_CONTRACT_ADDRESS ??=
  "0xd4b9fdB83C723c096d7fBE72da252aa23f1387aa"

const { buildHealthResponse, getHealthStatus } = await import("./health.js")

test("buildHealthResponse uses the slowest hub and oracle checkpoints", () => {
  const health = buildHealthResponse({
    hubRoleLastProcessedBlock: 995,
    hubTransferLastProcessedBlock: 990,
    latestChainBlock: 1_000,
    maxAllowedLag: 25,
    oracleExecutionLastProcessedBlock: 997,
    oracleRoleLastProcessedBlock: 980,
  })

  assert.equal(health.hub.lastProcessedBlock, 990)
  assert.equal(health.hub.lag, 10)
  assert.equal(health.oracle.lastProcessedBlock, 980)
  assert.equal(health.oracle.lag, 20)
  assert.deepEqual(health.failedEvents, {
    count: 0,
    oldestBlockNumber: null,
  })
  assert.equal(health.ok, true)
})

test("buildHealthResponse measures lag against the confirmed indexing target", () => {
  const health = buildHealthResponse({
    hubRoleLastProcessedBlock: 988,
    hubTransferLastProcessedBlock: 988,
    latestChainBlock: 1_000,
    latestIndexedBlock: 988,
    maxAllowedLag: 0,
    oracleExecutionLastProcessedBlock: 988,
    oracleRoleLastProcessedBlock: 988,
  })

  assert.equal(health.latestChainBlock, 1_000)
  assert.equal(health.latestIndexedBlock, 988)
  assert.equal(health.hub.lag, 0)
  assert.equal(health.oracle.lag, 0)
  assert.equal(health.ok, true)
})

test("buildHealthResponse reports unhealthy when checkpoints are missing or exceed lag threshold", () => {
  const health = buildHealthResponse({
    hubRoleLastProcessedBlock: 495,
    hubTransferLastProcessedBlock: null,
    latestChainBlock: 500,
    maxAllowedLag: 10,
    oracleExecutionLastProcessedBlock: 490,
    oracleRoleLastProcessedBlock: 489,
  })

  assert.equal(health.hub.lastProcessedBlock, null)
  assert.equal(health.hub.lag, 500)
  assert.equal(health.oracle.lastProcessedBlock, 489)
  assert.equal(health.oracle.lag, 11)
  assert.equal(health.ok, false)
})

test("buildHealthResponse reports unhealthy when failed events are pending", () => {
  const health = buildHealthResponse({
    failedEvents: {
      count: 5,
      oldestBlockNumber: 123,
    },
    hubRoleLastProcessedBlock: 990,
    hubTransferLastProcessedBlock: 990,
    latestChainBlock: 1_000,
    maxAllowedLag: 25,
    oracleExecutionLastProcessedBlock: 990,
    oracleRoleLastProcessedBlock: 990,
  })

  assert.deepEqual(health.failedEvents, {
    count: 5,
    oldestBlockNumber: 123,
  })
  assert.equal(health.ok, false)
})

test("buildHealthResponse reports unhealthy when indexer audits fail", () => {
  const health = buildHealthResponse({
    audits: {
      consecutiveFailures: 2,
      failureThreshold: 1,
      kinds: [
        {
          auditBlock: 990,
          checkedCount: 10,
          completedAt: "2026-06-06T12:00:00.000Z",
          confirmedCount: 1,
          consecutiveConfirmedRuns: 2,
          error: null,
          kind: "balance-drift",
          ok: false,
          pendingCount: 0,
          reason: "confirmed audit findings exceeded threshold",
          startedAt: "2026-06-06T11:59:00.000Z",
          status: "succeeded",
        },
      ],
      maxAgeMs: 30 * 60 * 1000,
      ok: false,
    },
    failedEvents: {
      count: 0,
      oldestBlockNumber: null,
    },
    hubRoleLastProcessedBlock: 990,
    hubTransferLastProcessedBlock: 990,
    latestChainBlock: 1_000,
    maxAllowedLag: 25,
    oracleExecutionLastProcessedBlock: 990,
    oracleRoleLastProcessedBlock: 990,
  })

  assert.equal(health.ok, false)
  assert.equal(health.audits?.ok, false)
})

test("getHealthStatus can omit audit health for readiness", async () => {
  const db = {
    manyOrNone: async () => {
      throw new Error("audit health should not be queried")
    },
    one: async () => ({
      count: 0,
      oldest_block_number: null,
    }),
    oneOrNone: async () => ({
      value: "990",
    }),
  } as unknown as Parameters<typeof getHealthStatus>[0]
  const provider = {
    getBlockNumber: async () => 1_000,
  } as Parameters<typeof getHealthStatus>[1]

  const health = await getHealthStatus(db, provider, { includeAudits: false })

  assert.equal(health.ok, true)
  assert.equal(health.audits, undefined)
})
