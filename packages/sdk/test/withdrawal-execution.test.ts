import { describe, it, expect } from "vitest"
import { getWithdrawalAddress } from "../src/messages/v2.2/withdrawal-execution"
import { getAddress } from "viem"

describe("getWithdrawalAddress", () => {
  it("should return a valid withdrawal address", () => {
    const params = {
      depository: "0x1234567890123456789012345678901234567890",
      depositoryChainId: 1n,
      currency: "10340230",
      recipient: "0x9876543210987654321098765432109876543210",
      withdrawerAlias: "0x9876543210987654321098765432109876543210",
      withdrawalNonce: "haha",
    }

    const address = getWithdrawalAddress(params)
    expect(address).toMatch(/^0x[0-9a-f]{40}$/i)
    expect(address).toBe("0x137217a86a5450584d540cc307b83e225ebd5c54")
    expect(getAddress(address).toLowerCase()).toMatch(address)
  })
})
