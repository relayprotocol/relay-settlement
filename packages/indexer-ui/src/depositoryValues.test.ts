import assert from "node:assert/strict"
import { test } from "vitest"
import type { DepositoryState } from "./api/schema"
import { assetValues } from "./depositoryValues"

const state = (
  tokenId: string,
  asset: string,
  balance: string,
  decimals: number
): DepositoryState => ({
  token_id: tokenId,
  last_attempt_at: "2026-10-05T00:00:00Z",
  error: null,
  target: { origin_asset: asset, decimals },
  snapshot: {
    balance,
    decimals,
    block_number: 1,
    custody_address: "0x0",
    observed_at: "2026-10-05T00:00:00Z",
  },
})

test("facade balances count once toward the depository value", () => {
  const states = [
    state(
      "1",
      "0x0000000000000000000000000000000000000000",
      "5000000000000000000",
      18
    ),
    state("2", "0x3600000000000000000000000000000000000000", "5000000", 6),
    state("3", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "2000000", 6),
  ]
  const facades = [
    {
      name: "usdc",
      address: "0x3600000000000000000000000000000000000000",
      target: "0x0000000000000000000000000000000000000000",
    },
  ]
  assert.equal(assetValues(states, () => "1").total, 12)
  assert.equal(assetValues(states, () => "1", facades).total, 7)
})
