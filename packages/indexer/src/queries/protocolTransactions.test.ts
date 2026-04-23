import assert from "node:assert/strict"
import test from "node:test"
import type { EventRow, OracleExecutionRow } from "../models/db.js"
import { projectProtocolTransactions } from "./protocolTransactions.js"

test("projectProtocolTransactions groups by tx hash and preserves first-seen hash order", () => {
  const transferRows: EventRow[] = [
    {
      amount: "5",
      block_number: 11,
      from_addr: "0x1111111111111111111111111111111111111111",
      log_index: 7,
      operator: "0xop2",
      timestamp: 1710000001,
      to_addr: "0x0000000000000000000000000000000000000000",
      token_id: "token-2",
      tx_hash: "0xtwo",
    },
    {
      amount: "10",
      block_number: 10,
      from_addr: "0x0000000000000000000000000000000000000000",
      log_index: 4,
      operator: "0xop1",
      timestamp: 1710000000,
      to_addr: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
      token_id: "token-1",
      tx_hash: "0xone",
    },
    {
      amount: "3",
      block_number: 10,
      from_addr: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
      log_index: 2,
      operator: "0xop1",
      timestamp: 1710000000,
      to_addr: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      token_id: "token-1",
      tx_hash: "0xone",
    },
  ]

  const oracleRows: OracleExecutionRow[] = [
    {
      actions_json: JSON.stringify(["0xbbb"]),
      aggregated_signature: null,
      block_number: 10,
      idempotency_key: "0xkey-2",
      log_index: 9,
      oracle_contract_address: "0xoracle",
      submitted_oracle_address: null,
      timestamp: 1710000000,
      tx_hash: "0xone",
    },
    {
      actions_json: JSON.stringify(["0xaaa"]),
      aggregated_signature: "0xsig",
      block_number: 10,
      idempotency_key: "0xkey-1",
      log_index: 1,
      oracle_contract_address: "0xoracle",
      submitted_oracle_address: "0xsigner",
      timestamp: 1710000000,
      tx_hash: "0xone",
    },
  ]

  const transactions = projectProtocolTransactions({
    oracleRows,
    transferRows,
    txHashes: ["0xone", "0xmissing", "0xtwo"],
  })

  assert.deepEqual(
    transactions.map((transaction) => transaction.txHash),
    ["0xone", "0xtwo"]
  )

  assert.equal(transactions[0].relayOperation, "mixed")
  assert.deepEqual(
    transactions[0].transfers.map((transfer) => transfer.logIndex),
    [2, 4]
  )
  assert.deepEqual(
    transactions[0].oracleExecutions.map((execution) => execution.logIndex),
    [1, 9]
  )
  assert.deepEqual(transactions[0].oracleExecutions[0].actions, ["0xaaa"])
  assert.equal(
    transactions[0].oracleExecutions[0].submittedOracleAddress,
    "0xsigner"
  )
  assert.equal(transactions[0].oracleExecutions[0].aggregatedSignature, "0xsig")
  assert.equal(transactions[1].relayOperation, "burn")
})

test("projectProtocolTransactions throws when oracle actions_json is invalid", () => {
  const transferRows: EventRow[] = [
    {
      amount: "10",
      block_number: 10,
      from_addr: "0x0000000000000000000000000000000000000000",
      log_index: 1,
      operator: "0xop1",
      timestamp: 1710000000,
      to_addr: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
      token_id: "token-1",
      tx_hash: "0xone",
    },
  ]

  const oracleRows: OracleExecutionRow[] = [
    {
      actions_json: JSON.stringify(["0xaaa", 7]),
      aggregated_signature: null,
      block_number: 10,
      idempotency_key: "0xkey-1",
      log_index: 2,
      oracle_contract_address: "0xoracle",
      submitted_oracle_address: null,
      timestamp: 1710000000,
      tx_hash: "0xone",
    },
  ]

  assert.throws(
    () =>
      projectProtocolTransactions({
        oracleRows,
        transferRows,
        txHashes: ["0xone"],
      }),
    /Invalid oracle actions_json/
  )
})
