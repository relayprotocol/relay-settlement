import assert from "node:assert/strict"
import test from "node:test"
import { isApiKeyAuthorized } from "./auth.js"

test("isApiKeyAuthorized allows requests when auth is disabled", () => {
  assert.equal(isApiKeyAuthorized(undefined, undefined), true)
  assert.equal(isApiKeyAuthorized("anything", undefined), true)
})

test("isApiKeyAuthorized validates a single api key header", () => {
  assert.equal(isApiKeyAuthorized("secret", "secret"), true)
  assert.equal(isApiKeyAuthorized("wrong", "secret"), false)
  assert.equal(isApiKeyAuthorized(undefined, "secret"), false)
})

test("isApiKeyAuthorized accepts matching repeated header values", () => {
  assert.equal(isApiKeyAuthorized(["wrong", "secret"], "secret"), true)
  assert.equal(isApiKeyAuthorized(["wrong", "other"], "secret"), false)
})
