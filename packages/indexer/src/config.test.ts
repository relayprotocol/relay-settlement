import test from "node:test"
import assert from "node:assert/strict"
import {
  relayNetworkDefaults,
  resolveAddress,
  resolveBoolean,
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

test("validateRuntimeConfig requires an api key by default", () => {
  assert.throws(
    () =>
      validateRuntimeConfig({
        allowUnauthenticatedApi: false,
        authApiKey: undefined,
        databaseUrl: undefined,
        doBackgroundWork: true,
        enableApi: true,
        hubContractAddress: relayNetworkDefaults.hubContractAddress,
        hubStartBlock: relayNetworkDefaults.startBlock,
        oracleContractAddress: relayNetworkDefaults.oracleContractAddress,
        oracleStartBlock: relayNetworkDefaults.startBlock,
        port: 3001,
        startBlock: relayNetworkDefaults.startBlock,
      }),
    {
      message:
        "AUTH_API_KEY is required when ENABLE_API=1 unless ALLOW_UNAUTHENTICATED_API=1",
    }
  )
})

test("validateRuntimeConfig allows explicit unauthenticated api mode", () => {
  assert.doesNotThrow(() =>
    validateRuntimeConfig({
      allowUnauthenticatedApi: true,
      authApiKey: undefined,
      databaseUrl: undefined,
      doBackgroundWork: true,
      enableApi: true,
      hubContractAddress: relayNetworkDefaults.hubContractAddress,
      hubStartBlock: relayNetworkDefaults.startBlock,
      oracleContractAddress: relayNetworkDefaults.oracleContractAddress,
      oracleStartBlock: relayNetworkDefaults.startBlock,
      port: 3001,
      startBlock: relayNetworkDefaults.startBlock,
    })
  )
})
