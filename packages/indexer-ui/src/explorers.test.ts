import assert from "node:assert/strict"
import { test } from "vitest"
import { explorerUrl } from "./explorers"

test("explorer links use chain-specific account paths", () => {
  assert.equal(
    explorerUrl("ethereum", "address", "0xabc"),
    "https://etherscan.io/address/0xabc"
  )
  assert.equal(
    explorerUrl(
      "solana",
      "address",
      "So11111111111111111111111111111111111111112"
    ),
    "https://solscan.io/account/So11111111111111111111111111111111111111112"
  )
  assert.equal(
    explorerUrl("bitcoin", "tx", "ab12"),
    "https://mempool.space/tx/ab12"
  )
  assert.equal(explorerUrl("unknown", "tx", "0x1"), undefined)
})
