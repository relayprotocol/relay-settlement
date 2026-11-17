import assert from "node:assert/strict"
import { test } from "vitest"
import { formatAmount } from "./utils"

const LIMIT = (2n ** 254n - 1n).toString()

test("oversized amounts use scientific notation", () => {
  assert.equal(formatAmount(LIMIT, 6, 2), "2.89e70")
  assert.equal(formatAmount(LIMIT, 18, 2), "2.89e58")
  assert.equal(formatAmount(`-${LIMIT}`, 6, 2), "-2.89e70")
  assert.equal(formatAmount("1000000000000000000000", 6, 2), "1.00e15")
  assert.equal(
    formatAmount("999999999999999000000", 6, 2),
    "999,999,999,999,999"
  )
})

test("full precision keeps every digit", () => {
  assert.equal(
    formatAmount(LIMIT, 18, Infinity),
    "28,948,022,309,329,048,855,892,746,252,171,976,963,317,496,166,410,141,009,864.396001978282409983"
  )
  assert.equal(formatAmount("1234567", 6, 2), "1.23")
})
