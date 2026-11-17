import { getAddress } from "viem"
import { describe, expect, it } from "vitest"
import { getOrderAddress } from "@relay-protocol/settlement-sdk"
import { getLegacyOrderAddress } from "../scripts/helpers/legacyOrderAddress"

const params = {
  chainId: "arbitrum",
  depositId:
    "0x9400f1b21cb527d7fa3d3eabba93557a18ebe7a2ca4e471cfe5e4c5b4ca7f767",
  depositor: "0x1111111111111111111111111111111111111111",
  timestamp: 1750000000n,
  vmType: "ethereum-vm" as const,
}

describe("getLegacyOrderAddress", () => {
  it("matches the SDK's former getOrderAddressSafe derivation", () => {
    // Expected value computed with getOrderAddressSafe from
    // @relay-protocol/settlement-sdk@0.0.143.
    expect(getAddress(getLegacyOrderAddress(params))).toBe(
      "0x548A18b91a68B497e9fc235990199297B7ec7822"
    )
  })

  it("differs from the current order address derivation", () => {
    expect(getLegacyOrderAddress(params)).not.toBe(getOrderAddress(params))
  })
})
