import assert from "node:assert/strict"
import test from "node:test"
import { buildReadinessResponse } from "./runtimeState.js"

test("buildReadinessResponse is ready when required roles are ready", () => {
  const response = buildReadinessResponse({
    apiReady: true,
    backgroundWorkError: null,
    backgroundWorkReady: true,
    doBackgroundWork: true,
    enableApi: true,
  })

  assert.equal(response.ok, true)
  assert.deepEqual(response.api, {
    ready: true,
    required: true,
  })
  assert.deepEqual(response.backgroundWork, {
    error: null,
    ready: true,
    required: true,
  })
})

test("buildReadinessResponse does not require disabled roles", () => {
  const response = buildReadinessResponse({
    apiReady: false,
    backgroundWorkError: null,
    backgroundWorkReady: true,
    doBackgroundWork: true,
    enableApi: false,
  })

  assert.equal(response.ok, true)
  assert.deepEqual(response.api, {
    ready: false,
    required: false,
  })
})

test("buildReadinessResponse reports background errors", () => {
  const response = buildReadinessResponse({
    apiReady: true,
    backgroundWorkError: "Indexer stopped",
    backgroundWorkReady: false,
    doBackgroundWork: true,
    enableApi: true,
  })

  assert.equal(response.ok, false)
  assert.deepEqual(response.backgroundWork, {
    error: "Indexer stopped",
    ready: false,
    required: true,
  })
})
