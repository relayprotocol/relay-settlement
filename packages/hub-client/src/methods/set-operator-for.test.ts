import { describe, expect, it } from "vitest"
import { createHubClient } from ".."

const hubClient = createHubClient({
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  chainId: "ethereum",
})

describe("setOperatorFor", () => {
  it("should prepare the setOperatorFor transaction", async () => {
    const tx = await hubClient.setOperatorFor({
      account: "0x1D682340264cF209257f24C3EDcb2a9fc0592535",
      approved: true,
      chainId: "ethereum",
      family: "ethereum-vm",
      operatorAddress: "0xd62B65923E77Be56ae35C46D90A85D74a83A4A9c",
    })
    expect(tx.data).toEqual(
      "0xc29ffa4100000000000000000000000048f534a952f8ee0cf3ef84ca71f6a2b46fab13a00000000000000000000000003424f4f3aed516ae878c1a692b65fc5ab2278aed0000000000000000000000000000000000000000000000000000000000000001"
    )
    expect(tx.value).toEqual(0n)
  })
})
