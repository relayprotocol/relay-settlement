import assert from "node:assert/strict"
import { test } from "vitest"
import { ApiError, ConnectionError, shouldRetry, unwrap } from "./client"

const failure = (error: unknown, init: ResponseInit) =>
  unwrap(Promise.resolve({ error, response: new Response(null, init) })).catch(
    (error: unknown) => error
  )

test("error responses become ApiErrors and only server errors retry", async () => {
  const unauthorized = await failure(
    { code: 401, kind: "unauthorized", message: "Invalid API key" },
    { status: 401 }
  )
  assert.ok(unauthorized instanceof ApiError)
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.message, "Request returned 401: Invalid API key")
  assert.equal(shouldRetry(0, unauthorized), false)

  const internal = await failure(
    { code: 503, kind: "internal_error", message: "Database unavailable" },
    { status: 503 }
  )
  assert.ok(internal instanceof ApiError)
  assert.equal(shouldRetry(0, internal), true)
  assert.equal(shouldRetry(3, internal), false)
})

test("unreachable APIs become ConnectionErrors", async () => {
  const gateway = await failure("<html>", {
    status: 502,
    statusText: "Bad Gateway",
  })
  assert.ok(gateway instanceof ConnectionError)
  assert.equal(shouldRetry(0, gateway), true)

  const network = await unwrap(
    Promise.reject(new TypeError("Failed to fetch"))
  ).catch((error: unknown) => error)
  assert.ok(network instanceof ConnectionError)
  assert.equal(network.message, "Cannot reach the indexer API")
})
