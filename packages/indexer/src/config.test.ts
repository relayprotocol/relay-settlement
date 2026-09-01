import test from "node:test"
import assert from "node:assert/strict"
import {
  relayNetworkDefaults,
  resolveAddress,
  resolveBoolean,
  resolveEnableApi,
  resolveNonNegativeInteger,
  resolveNumber,
  resolvePort,
  validateRuntimeConfig,
} from "./config.js"

test("resolvePort falls back to default when unset", () => {
  assert.equal(resolvePort(undefined), 3001)
})

test("resolvePort accepts a numeric env value", () => {
  assert.equal(resolvePort("4100"), 4100)
})

test("resolveNumber falls back when unset or invalid", () => {
  assert.equal(resolveNumber(undefined, 10), 10)
  assert.equal(resolveNumber("nope", 10), 10)
})

test("resolveNumber accepts a numeric env value", () => {
  assert.equal(resolveNumber("42", 10), 42)
})

test("resolveNonNegativeInteger clamps unsafe values", () => {
  assert.equal(resolveNonNegativeInteger("-1", 10), 0)
  assert.equal(resolveNonNegativeInteger("12.8", 10), 12)
  assert.equal(resolveNonNegativeInteger("nope", 10), 10)
})

test("resolveBoolean falls back when unset", () => {
  assert.equal(resolveBoolean(undefined, true), true)
  assert.equal(resolveBoolean(undefined, false), false)
})

test("resolveBoolean parses numeric flags", () => {
  assert.equal(resolveBoolean("1", false), true)
  assert.equal(resolveBoolean("0", true), false)
})

test("resolveBoolean parses boolean strings", () => {
  assert.equal(resolveBoolean("true", false), true)
  assert.equal(resolveBoolean("false", true), false)
})

test("resolveBoolean rejects unrecognized values", () => {
  assert.throws(() => resolveBoolean("yes", true), {
    message: "Invalid boolean env value: yes",
  })
})

test("resolveAddress uses normalized relay metadata defaults", () => {
  assert.equal(
    resolveAddress(undefined, relayNetworkDefaults.hubContractAddress),
    relayNetworkDefaults.hubContractAddress
  )
})

test("resolveAddress normalizes explicit overrides", () => {
  assert.equal(
    resolveAddress("0xDDD361727C22A01EB137880678A20b0BEaE69318", "fallback"),
    relayNetworkDefaults.hubContractAddress
  )
})

test("resolveEnableApi disables the api when no auth mode is available", () => {
  assert.equal(resolveEnableApi(true, undefined, false), false)
})

test("resolveEnableApi keeps the api enabled with an auth key", () => {
  assert.equal(resolveEnableApi(true, "secret", false), true)
})

test("resolveEnableApi keeps the api enabled in explicit unauthenticated mode", () => {
  assert.equal(resolveEnableApi(true, undefined, true), true)
})

test("validateRuntimeConfig requires a database url for api or background work", () => {
  assert.throws(
    () =>
      validateRuntimeConfig({
        allowUnauthenticatedApi: true,
        apiRequested: false,
        authApiKey: undefined,
        batchSize: 2000,
        confirmationBlocks: 12,
        databaseUrl: undefined,
        depositoryBalanceAuditIntervalMs: 10 * 60 * 1000,
        doBackgroundWork: true,
        enableApi: false,
        healthMaxLagBlocks: 500,
        hubContractAddress: relayNetworkDefaults.hubContractAddress,
        hubStartBlock: relayNetworkDefaults.startBlock,
        indexerAuditConsecutiveFailures: 2,
        indexerAuditFailureThreshold: 1,
        indexerAuditIntervalMs: 15 * 60 * 1000,
        indexerAuditMaxAgeMs: 30 * 60 * 1000,
        maxTransferReplayBlockRange: 100_000,
        oracleApiUrl: "https://oracle.example",
        oracleContractAddress: relayNetworkDefaults.oracleContractAddress,
        oracleStartBlock: relayNetworkDefaults.startBlock,
        pollIntervalMs: 5000,
        port: 3001,
        priceOracleContractAddress:
          relayNetworkDefaults.priceOracleContractAddress,
        rpcHttpUrl: undefined,
        rpcWsUrl: "wss://rpc.chain.relay.link/rpc",
        startBlock: relayNetworkDefaults.startBlock,
        transferCoverageAuditLookbackBlocks: 5000,
        transferOverlapBlocks: 250,
      }),
    {
      message:
        "DATABASE_URL is required when ENABLE_API=1 or DO_BACKGROUND_WORK=1",
    }
  )
})

test("validateRuntimeConfig requires an rpc ws url for background work", () => {
  assert.throws(
    () =>
      validateRuntimeConfig({
        allowUnauthenticatedApi: true,
        apiRequested: false,
        authApiKey: undefined,
        batchSize: 2000,
        confirmationBlocks: 12,
        databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54329/indexer",
        depositoryBalanceAuditIntervalMs: 10 * 60 * 1000,
        doBackgroundWork: true,
        enableApi: false,
        healthMaxLagBlocks: 500,
        hubContractAddress: relayNetworkDefaults.hubContractAddress,
        hubStartBlock: relayNetworkDefaults.startBlock,
        indexerAuditConsecutiveFailures: 2,
        indexerAuditFailureThreshold: 1,
        indexerAuditIntervalMs: 15 * 60 * 1000,
        indexerAuditMaxAgeMs: 30 * 60 * 1000,
        maxTransferReplayBlockRange: 100_000,
        oracleApiUrl: "https://oracle.example",
        oracleContractAddress: relayNetworkDefaults.oracleContractAddress,
        oracleStartBlock: relayNetworkDefaults.startBlock,
        pollIntervalMs: 5000,
        port: 3001,
        priceOracleContractAddress:
          relayNetworkDefaults.priceOracleContractAddress,
        rpcHttpUrl: undefined,
        rpcWsUrl: undefined,
        startBlock: relayNetworkDefaults.startBlock,
        transferCoverageAuditLookbackBlocks: 5000,
        transferOverlapBlocks: 250,
      }),
    {
      message: "RPC_WS_URL is required when DO_BACKGROUND_WORK=1",
    }
  )
})

test("runtime config defaults the api off for worker-first deploys", () => {
  assert.equal(resolveBoolean(undefined, false), false)
})
