import { decodeAbiParameters, parseAbiParameters } from "viem"
import { describe, it, expect } from "vitest"

import {
  ActionType,
  encodeAction,
  decodeAction,
} from "../src/messages/v2.2/execution"

const actions = [
  {
    type: ActionType.MINT,
    data: {
      hubToAddress: "0x1234567890123456789012345678901234567890",
      hubTokenId: 1n,
      amount: "1000",
    },
  },
  {
    type: ActionType.BURN,
    data: {
      hubFromAddress: "0x9876543210987654321098765432109876543210",
      hubTokenId: 2n,
      amount: "500",
    },
  },
  {
    type: ActionType.TRANSFER,
    data: {
      hubFromAddress: "0x1111111111111111111111111111111111111111",
      hubToAddress: "0x2222222222222222222222222222222222222222",
      hubTokenId: 3n,
      amount: "250",
    },
  },
  {
    type: ActionType.FAST_MINT,
    data: {
      hubToAddress: "0x3333333333333333333333333333333333333333",
      hubTokenId: 777n,
      chainId: "8453",
      amount: "1000000",
      feeBps: "10000000000000000", // 1% (1e16 / 1e18)
      feeRecipient: "0x4444444444444444444444444444444444444444",
      usdValue: "1000000",
    },
  },
]

describe("execution", () => {
  it("should encode and decode MINT action correctly", () => {
    const action = actions[0]
    const encoded = encodeAction(action as any)
    const decoded = decodeAction(encoded)

    expect(decoded.type).toBe(ActionType.MINT)
    expect("hubToAddress" in decoded.data && decoded.data.hubToAddress).toBe(
      action.data.hubToAddress
    )
    expect(decoded.data.hubTokenId).toBe(action.data.hubTokenId)
    expect(decoded.data.amount).toBe(action.data.amount)
  })

  it("should encode and decode BURN action correctly", () => {
    const action = actions[1]
    const encoded = encodeAction(action as any)
    const decoded = decodeAction(encoded)
    expect(decoded.type).toBe(ActionType.BURN)
    expect(
      "hubFromAddress" in decoded.data && decoded.data.hubFromAddress
    ).toBe(action.data.hubFromAddress)
    expect(decoded.data.hubTokenId).toBe(action.data.hubTokenId)
    expect(decoded.data.amount).toBe(action.data.amount)
  })

  it("should encode and decode TRANSFER action correctly", () => {
    const action = actions[2]
    const encoded = encodeAction(action as any)
    const decoded = decodeAction(encoded)
    expect(decoded.type).toBe(ActionType.TRANSFER)
    expect(
      "hubFromAddress" in decoded.data && decoded.data.hubFromAddress
    ).toBe(action.data.hubFromAddress)
    expect("hubToAddress" in decoded.data && decoded.data.hubToAddress).toBe(
      action.data.hubToAddress
    )
    expect(decoded.data.hubTokenId).toBe(action.data.hubTokenId)
    expect(decoded.data.amount).toBe(action.data.amount)
  })

  it("should encode and decode FAST_MINT action correctly", () => {
    const action = actions[3]
    const encoded = encodeAction(action as any)
    const decoded = decodeAction(encoded)

    expect(decoded.type).toBe(ActionType.FAST_MINT)
    if (decoded.type !== ActionType.FAST_MINT) throw new Error("wrong type")
    expect(decoded.data.hubToAddress).toBe(action.data.hubToAddress)
    expect(decoded.data.hubTokenId).toBe(action.data.hubTokenId)
    expect(decoded.data.chainId).toBe(action.data.chainId)
    expect(decoded.data.amount).toBe(action.data.amount)
    expect(decoded.data.feeBps).toBe(action.data.feeBps)
    expect(decoded.data.feeRecipient).toBe(action.data.feeRecipient)
    expect(decoded.data.usdValue).toBe(action.data.usdValue)
  })

  // The encoded layout must match exactly what RelayOracleV2._executeFastMint decodes —
  // abi.decode(action, (uint8, address, uint256, string, uint256, uint256, address, uint256)).
  it("FAST_MINT layout matches the contract decode tuple", () => {
    const action = actions[3]
    const encoded = encodeAction(action as any)

    const [
      type,
      hubTo,
      hubTokenId,
      chainId,
      amount,
      feeBps,
      feeRecipient,
      usdValue,
    ] = decodeAbiParameters(
      parseAbiParameters(
        "uint8, address, uint256, string, uint256, uint256, address, uint256"
      ),
      encoded as `0x${string}`
    )

    expect(type).toBe(ActionType.FAST_MINT)
    expect((hubTo as string).toLowerCase()).toBe(action.data.hubToAddress)
    expect(hubTokenId).toBe(action.data.hubTokenId)
    expect(chainId).toBe(action.data.chainId)
    expect(amount).toBe(1000000n)
    expect(feeBps).toBe(10000000000000000n)
    expect((feeRecipient as string).toLowerCase()).toBe(
      action.data.feeRecipient
    )
    expect(usdValue).toBe(1000000n)
  })
})
