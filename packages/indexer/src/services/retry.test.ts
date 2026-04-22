import assert from "node:assert/strict"
import test from "node:test"
import { runWithRetry } from "./retry.js"

test("runWithRetry retries transient Postgres errors", async () => {
  let attempts = 0

  await runWithRetry(async () => {
    attempts += 1

    if (attempts === 1) {
      const error = new Error(
        "could not serialize access due to concurrent update"
      ) as Error & { code?: string }
      error.code = "40001"
      throw error
    }
  })

  assert.equal(attempts, 2)
})

test("runWithRetry does not retry non-transient errors", async () => {
  let attempts = 0

  await assert.rejects(
    () =>
      runWithRetry(async () => {
        attempts += 1
        throw new Error("boom")
      }),
    /boom/
  )

  assert.equal(attempts, 1)
})
