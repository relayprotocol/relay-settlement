import { describe, it, expect } from "vitest"

import { getOrderId, Order } from "../src/order"

describe("order", () => {
  it("should compute order id correctly", () => {
    const order: Order = {
      fees: [],
      salt: "0x0ef19e8ac216cebd161d73425c0b1e1ae12f5a4d56fc54cddb4f9755c5e7b1b8",
      inputs: [
        {
          payment: {
            amount: "100000000000000",
            weight: "1",
            chainId: "base",
            currency: "0x0000000000000000000000000000000000000000",
          },
          refunds: [
            {
              chainId: "base",
              currency: "0x0000000000000000000000000000000000000000",
              deadline: 1774878936,
              extraData:
                "0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
              recipient: "0x8B5E4dB198FfC7f69f8F11F6592f682717dF1D92",
              minimumAmount: "0",
            },
            {
              chainId: "solana",
              currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              deadline: 1774878936,
              extraData: "0x",
              recipient: "7EaP2zkxDLo86x4rnNwwLhB593PsbMva41dqfrfxhsb1",
              minimumAmount: "0",
            },
          ],
        },
      ],
      output: {
        calls: [],
        chainId: "solana",
        deadline: 1774878936,
        payments: [
          {
            currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            recipient: "7EaP2zkxDLo86x4rnNwwLhB593PsbMva41dqfrfxhsb1",
            minimumAmount: "187151",
            expectedAmount: "196567",
          },
        ],
        extraData: "0x",
      },
      solver: "0xfd073a9ccb34f8a13c466eb16dff990d6178a5ef",
      version: "v1",
      solverChainId: "base",
    }

    expect(
      getOrderId(order, {
        base: "ethereum-vm",
        bitcoin: "bitcoin-vm",
        solana: "solana-vm",
      })
    ).toBe("0x67f44dc715059f196cd133e54e4bbe125773cb6d7053d24389fbda361f4c14d8")
  })
})
