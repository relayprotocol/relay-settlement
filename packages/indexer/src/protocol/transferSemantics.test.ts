import assert from "node:assert/strict"
import test from "node:test"
import { ZeroAddress } from "ethers"
import {
  deriveRelayOperation,
  getProtocolTransferType,
  isZeroAddress,
} from "./transferSemantics.js"

test("isZeroAddress matches the canonical zero address case-insensitively", () => {
  assert.equal(isZeroAddress(ZeroAddress), true)
  assert.equal(isZeroAddress(ZeroAddress.toUpperCase()), true)
  assert.equal(
    isZeroAddress("0x1111111111111111111111111111111111111111"),
    false
  )
})

test("getProtocolTransferType classifies mint, burn, and transfer", () => {
  assert.equal(
    getProtocolTransferType(
      ZeroAddress,
      "0x1111111111111111111111111111111111111111"
    ),
    "mint"
  )
  assert.equal(
    getProtocolTransferType(
      "0x1111111111111111111111111111111111111111",
      ZeroAddress
    ),
    "burn"
  )
  assert.equal(
    getProtocolTransferType(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222"
    ),
    "transfer"
  )
})

test("deriveRelayOperation returns mixed for mixed transfer sets", () => {
  assert.equal(deriveRelayOperation([{ type: "mint" }]), "mint")
  assert.equal(
    deriveRelayOperation([{ type: "mint" }, { type: "transfer" }]),
    "mixed"
  )
})
