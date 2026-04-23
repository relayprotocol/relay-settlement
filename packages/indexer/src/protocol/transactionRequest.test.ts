import assert from "node:assert/strict"
import test from "node:test"
import {
  MAX_PROTOCOL_TRANSACTION_BATCH_SIZE,
  normalizeProtocolTransactionHashes,
  ProtocolTransactionRequestError,
} from "./transactionRequest.js"

test("normalizeProtocolTransactionHashes lowercases and dedupes hashes", () => {
  const hashes = normalizeProtocolTransactionHashes(["0xAbC", "0xdef", "0xabc"])

  assert.deepEqual(hashes, ["0xabc", "0xdef"])
})

test("normalizeProtocolTransactionHashes rejects invalid input", () => {
  assert.throws(
    () => normalizeProtocolTransactionHashes("0xabc"),
    ProtocolTransactionRequestError
  )
  assert.throws(
    () => normalizeProtocolTransactionHashes(["0xabc", 1]),
    ProtocolTransactionRequestError
  )
  assert.throws(
    () => normalizeProtocolTransactionHashes([]),
    ProtocolTransactionRequestError
  )
})

test("normalizeProtocolTransactionHashes enforces the batch limit", () => {
  const overLimit = Array.from(
    { length: MAX_PROTOCOL_TRANSACTION_BATCH_SIZE + 1 },
    (_, index) => `0x${index.toString(16).padStart(40, "0")}`
  )

  assert.throws(
    () => normalizeProtocolTransactionHashes(overLimit),
    ProtocolTransactionRequestError
  )
})
