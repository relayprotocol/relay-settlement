import assert from "node:assert/strict"
import test from "node:test"
import { jsonLogger } from "./logger.js"

test("jsonLogger emits structured JSON", () => {
  const originalConsoleError = console.error
  let output = ""
  console.error = (value) => {
    output = String(value)
  }

  try {
    jsonLogger.error("test-scope", "Test message", {
      amount: 123n,
      error: new Error("test error"),
      event: "test_event",
    })
  } finally {
    console.error = originalConsoleError
  }

  const parsed = JSON.parse(output)
  assert.equal(parsed.level, "error")
  assert.equal(parsed.status, "error")
  assert.equal(parsed.scope, "test-scope")
  assert.equal(parsed.message, "Test message")
  assert.equal(parsed.event, "test_event")
  assert.equal(parsed.amount, "123")
  assert.equal(parsed.error.name, "Error")
  assert.equal(parsed.error.message, "test error")
  assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T/)
})

test("jsonLogger prevents data from overriding Datadog log status", () => {
  const originalConsoleInfo = console.info
  let output = ""
  console.info = (value) => {
    output = String(value)
  }

  try {
    jsonLogger.info("test-scope", "Successful audit", {
      status: "critical",
    })
  } finally {
    console.info = originalConsoleInfo
  }

  const parsed = JSON.parse(output)
  assert.equal(parsed.level, "info")
  assert.equal(parsed.status, "info")
})
