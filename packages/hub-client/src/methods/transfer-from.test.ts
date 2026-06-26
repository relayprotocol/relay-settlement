import { ethers } from "ethers"
import { describe, expect, it } from "vitest"
import { createHubClient } from ".."

const hubClient = createHubClient({
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  chainId: "ethereum",
})

describe("transferFrom", () => {
  it("should prepare the transferFrom transaction", async () => {
    const tx = await hubClient.transferFrom({
      account: "0x1D682340264cF209257f24C3EDcb2a9fc0592535",
      amount: ethers.parseUnits("1", 18),
      chainId: "ethereum",
      family: "ethereum-vm",
      recipientAddress: "0xd62B65923E77Be56ae35C46D90A85D74a83A4A9c",
      tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    })
    expect(tx.data).toEqual(
      "0xfe99049a00000000000000000000000048f534a952f8ee0cf3ef84ca71f6a2b46fab13a00000000000000000000000003424f4f3aed516ae878c1a692b65fc5ab2278aedae90d0e5c4c1f0215bffd35b2984c32cf7e4e852916e144750a352b82524ef860000000000000000000000000000000000000000000000000de0b6b3a7640000"
    )
    expect(tx.value).toEqual(0n)
  })
})
