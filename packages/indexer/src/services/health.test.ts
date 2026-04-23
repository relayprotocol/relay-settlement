import assert from "node:assert/strict"
import test from "node:test"

process.env.RPC_WS_URL ??= "ws://127.0.0.1:8545"
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@127.0.0.1:5432/relay_settlement_indexer_test"
process.env.HUB_CONTRACT_ADDRESS ??=
  "0xDDD361727C22A01EB137880678A20b0BEaE69318"
process.env.ORACLE_CONTRACT_ADDRESS ??=
  "0xd4b9fdB83C723c096d7fBE72da252aa23f1387aa"

const { buildHealthResponse } = await import("./health.js")

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
