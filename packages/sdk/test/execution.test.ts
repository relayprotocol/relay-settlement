import { decodeAbiParameters, parseAbiParameters } from "viem"
import { describe, it, expect } from "vitest"

import {
  ActionType,
  encodeAction,
  decodeAction,
  encodeAmountLimiterData,
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
      hubTokenId: 123456789n,
      amount: "1000000",
      feeBps: "10000000000000000", // 1% (1e16 / 1e18)
      feeRecipient: "0x4444444444444444444444444444444444444444",
      limiter: "0x5555555555555555555555555555555555555555",
      limiterData: encodeAmountLimiterData(
        "8453",
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "1000000"
      ),
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
    expect(decoded.data.amount).toBe(action.data.amount)
    expect(decoded.data.feeBps).toBe(action.data.feeBps)
    expect(decoded.data.feeRecipient).toBe(action.data.feeRecipient)
    expect(decoded.data.limiter).toBe(action.data.limiter)
    expect(decoded.data.limiterData).toBe(action.data.limiterData)
  })

  // The encoded layout must match exactly what RelayOracleV2._executeFastMint decodes —
  // abi.decode(action, (uint8, address, uint256, uint256, uint256, address, address, bytes)).
  it("FAST_MINT layout matches the contract decode tuple", () => {
    const action = actions[3]
    const encoded = encodeAction(action as any)

    const [
      type,
      hubTo,
      hubTokenId,
      amount,
      feeBps,
      feeRecipient,
      limiter,
      data,
    ] = decodeAbiParameters(
      parseAbiParameters(
        "uint8, address, uint256, uint256, uint256, address, address, bytes"
      ),
      encoded as `0x${string}`
    )

    expect(type).toBe(ActionType.FAST_MINT)
    expect((hubTo as string).toLowerCase()).toBe(action.data.hubToAddress)
    expect(hubTokenId).toBe(action.data.hubTokenId)
    expect(amount).toBe(1000000n)
    expect(feeBps).toBe(10000000000000000n)
    expect((feeRecipient as string).toLowerCase()).toBe(
      action.data.feeRecipient
    )
    expect((limiter as string).toLowerCase()).toBe(action.data.limiter)
    expect(data).toBe(action.data.limiterData)
  })

  it("encodeAmountLimiterData round-trips through the limiter's decode tuple", () => {
    const encoded = encodeAmountLimiterData(
      "8453",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "1000000"
    )
    const [chainId, currency, amount] = decodeAbiParameters(
      parseAbiParameters("string, bytes, uint256"),
      encoded as `0x${string}`
    )
    expect(chainId).toBe("8453")
    expect((currency as string).toLowerCase()).toBe(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    )
    expect(amount).toBe(1000000n)
  })
})
