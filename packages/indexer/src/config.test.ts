import test from "node:test"
import assert from "node:assert/strict"
import { resolvePort } from "./config.js"

test("resolvePort falls back to default when unset", () => {
  assert.equal(resolvePort(undefined), 3001)
})

test("resolvePort accepts a numeric env value", () => {
  assert.equal(resolvePort("4100"), 4100)
})
