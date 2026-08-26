// ABOUTME: OrderV2 EIP-712 hashing and normalization tests. The pinned order id is a
// ABOUTME: characterization vector — any change here means v2 order hashing changed.

import { describe, it, expect } from "vitest"

import { getOrderV2Id, normalizeOrderV2, OrderV2 } from "../src/order"
import { encodeAddressToHex } from "../src/utils"

const chainsConfig = {
  base: "ethereum-vm" as const,
  ethereum: "ethereum-vm" as const,
  solana: "solana-vm" as const,
}

const order: OrderV2 = {
  version: "v2",
  relayerChainId: "base",
  relayer: "0xfd073a9ccb34f8a13c466eb16dff990d6178a5ef",
  salt: "0x0ef19e8ac216cebd161d73425c0b1e1ae12f5a4d56fc54cddb4f9755c5e7b1b8",
  deadline: 1774878936,
  input: {
    chainId: "solana",
    currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "100000000",
  },
  refunds: [
    {
      chainId: "solana",
      currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      minimumAmount: "0",
      recipient: "7EaP2zkxDLo86x4rnNwwLhB593PsbMva41dqfrfxhsb1",
    },
    {
      chainId: "base",
      currency: "0x0000000000000000000000000000000000000000",
      minimumAmount: "0",
      recipient: "0x8B5E4dB198FfC7f69f8F11F6592f682717dF1D92",
    },
  ],
  output: {
    chainId: "base",
    withdraw: {
      currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      minimumAmount: "99000000",
    },
    fill: {
      currency: "0x4200000000000000000000000000000000000006",
      minimumAmount: "25000000000000000",
      recipient: "0x8B5E4dB198FfC7f69f8F11F6592f682717dF1D92",
      calls: [
        "0x000000000000000000000000000000000000000000000000000000000000002a",
      ],
    },
  },
  fees: [
    {
      recipientChainId: "base",
      recipient: "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
      currencyChainId: "base",
      currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000",
    },
  ],
}

describe("order v2", () => {
  it("should compute order id correctly", () => {
    expect(getOrderV2Id(order, chainsConfig)).toBe(
      "0x891a00b48e5c73016382af5eec240cca7cf6751c2ce572c09ba9c203f52168cc"
    )
  })

  it("normalizes addresses per chain vm type", () => {
    const normalized = normalizeOrderV2(order, chainsConfig)

    expect(normalized.input.currency).toBe(
      encodeAddressToHex(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "solana-vm"
      )
    )
    expect(normalized.refunds[1].recipient).toBe(
      "0x8B5E4dB198FfC7f69f8F11F6592f682717dF1D92".toLowerCase()
    )
    expect(normalized.output.withdraw.currency).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase()
    )
    expect(normalized.output.fill.recipient).toBe(
      "0x8B5E4dB198FfC7f69f8F11F6592f682717dF1D92".toLowerCase()
    )
  })

  it("commits to every field", () => {
    const baseId = getOrderV2Id(order, chainsConfig)

    const variants: OrderV2[] = [
      { ...order, deadline: order.deadline + 1 },
      { ...order, salt: "0x" + "11".repeat(32) },
      {
        ...order,
        input: { ...order.input, amount: "100000001" },
      },
      {
        ...order,
        refunds: [order.refunds[0]],
      },
      {
        ...order,
        output: {
          ...order.output,
          withdraw: {
            ...order.output.withdraw,
            minimumAmount: "99000001",
          },
        },
      },
      {
        ...order,
        output: {
          ...order.output,
          fill: {
            ...order.output.fill,
            recipient: "0x000000000000000000000000000000000000dEaD",
          },
        },
      },
      {
        ...order,
        output: {
          ...order.output,
          fill: { ...order.output.fill, calls: [] },
        },
      },
      {
        ...order,
        fees: [],
      },
    ]

    for (const variant of variants) {
      expect(getOrderV2Id(variant, chainsConfig)).not.toBe(baseId)
    }
  })
})
