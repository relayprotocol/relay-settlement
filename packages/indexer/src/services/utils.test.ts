import assert from "node:assert/strict"
import test from "node:test"
import { getBlockTimestamp } from "./utils.js"

test("getBlockTimestamp caches zero timestamps", async () => {
  let calls = 0
  const provider = {
    async getBlock() {
      calls += 1
      return { timestamp: 0 }
    },
  } as never

  const cache = new Map<number, number>()

  assert.equal(await getBlockTimestamp(provider, cache, 1), 0)
  assert.equal(await getBlockTimestamp(provider, cache, 1), 0)
  assert.equal(calls, 1)
})

test("getBlockTimestamp rejects missing blocks", async () => {
  const provider = {
    async getBlock() {
      return null
    },
  } as never

  await assert.rejects(
    () => getBlockTimestamp(provider, new Map<number, number>(), 42),
    /Block not found: 42/
  )
})
