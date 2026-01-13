import { describe, it, expect } from "vitest"
import {
  getSubmitWithdrawRequestHash,
  getWithdrawalAddress,
} from "../src/messages/v2.2/withdrawal-execution"
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
describe("getSubmitWithdrawRequestHash", () => {
  it("should return a valid payload id", () => {
    const params = {
      chainId: "2741",
      depository: "0x5cb1de3603a71ac2f67b12bfbf095013fe4ac299",
      currency: "0x0000000000000000000000000000000000000000",
      amount: "1688875045157513",
      spender: "0xFD3E80587416B94Ef6D9394b323d8E47699d073E",
      receiver: "0xfd073a9ccb34f8a13c466eb16dff990d6178a5ef",
      data: "0x",
      nonce:
        "0x9400f1b21cb527d7fa3d3eabba93557a18ebe7a2ca4e471cfe5e4c5b4ca7f767",
    }

    const payloadId = getSubmitWithdrawRequestHash(params)
    expect(payloadId).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(payloadId).toBe(
      "0xdb9f84f17ac6f8f3d9a0c703229915b2d8b57c2f3401641f2c88e8f0492e963a"
    )
  })
})
