import test from "node:test"
import assert from "node:assert/strict"
import { resolveBoolean, resolvePort, validateRuntimeConfig } from "./config.js"

test("resolvePort falls back to default when unset", () => {
  assert.equal(resolvePort(undefined), 3001)
})

test("resolvePort accepts a numeric env value", () => {
  assert.equal(resolvePort("4100"), 4100)
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

test("validateRuntimeConfig requires an api key by default", () => {
  assert.throws(
    () =>
      validateRuntimeConfig({
        allowUnauthenticatedApi: false,
        authApiKey: undefined,
        doBackgroundWork: true,
        enableApi: true,
        port: 3001,
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
      doBackgroundWork: true,
      enableApi: true,
      port: 3001,
    })
  )
})
