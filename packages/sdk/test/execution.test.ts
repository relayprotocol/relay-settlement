import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem"
import { describe, it, expect } from "vitest"

import {
  ActionType,
  encodeAction,
  decodeAction,
} from "../src/messages/v2.2/execution"

const encodeTestFeeCalculatorData = (
  feeCurrency: string | bigint,
  feeBps: string | bigint,
  feeRecipient: string,
  feePayer: string
) =>
  encodeAbiParameters(
    parseAbiParameters(
      "uint256 feeCurrency, uint256 feeBps, address feeRecipient, address feePayer"
    ),
    [
      BigInt(feeCurrency),
      BigInt(feeBps),
      feeRecipient as `0x${string}`,
      feePayer as `0x${string}`,
    ]
  )

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
      feeCalculator: "0x6666666666666666666666666666666666666666",
      feeCalculatorData: encodeTestFeeCalculatorData(
        123456789n,
        "10000000000000000",
        "0x4444444444444444444444444444444444444444",
        "0x3333333333333333333333333333333333333333"
      ), // 1% (1e16 / 1e18)
      rateLimiter: "0x5555555555555555555555555555555555555555",
      rateLimiterData: "0x",
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
    expect(decoded.data.feeCalculator).toBe(action.data.feeCalculator)
    expect(decoded.data.feeCalculatorData).toBe(action.data.feeCalculatorData)
    expect(decoded.data.rateLimiter).toBe(action.data.rateLimiter)
    expect(decoded.data.rateLimiterData).toBe(action.data.rateLimiterData)
  })

  // The encoded layout must match exactly what RelayOracleV2._executeFastMint decodes —
  // abi.decode(action, (uint8, address, uint256, uint256, address, bytes, address, bytes)).
  it("FAST_MINT layout matches the contract decode tuple", () => {
    const action = actions[3]
    const encoded = encodeAction(action as any)

    const [
      type,
      hubTo,
      hubTokenId,
      amount,
      feeCalculator,
      feeCalculatorData,
      rateLimiter,
      rateLimiterData,
    ] = decodeAbiParameters(
      parseAbiParameters(
        "uint8, address, uint256, uint256, address, bytes, address, bytes"
      ),
      encoded as `0x${string}`
    )

    expect(type).toBe(ActionType.FAST_MINT)
    expect((hubTo as string).toLowerCase()).toBe(action.data.hubToAddress)
    expect(hubTokenId).toBe(action.data.hubTokenId)
    expect(amount).toBe(1000000n)
    expect((feeCalculator as string).toLowerCase()).toBe(
      action.data.feeCalculator
    )
    expect(feeCalculatorData).toBe(action.data.feeCalculatorData)
    expect((rateLimiter as string).toLowerCase()).toBe(action.data.rateLimiter)
    expect(rateLimiterData).toBe(action.data.rateLimiterData)
  })

  it("test fee calculator data round-trips through the default fee calculator decode tuple", () => {
    const feeCurrency = 123456789n
    const feeRecipient = "0x4444444444444444444444444444444444444444"
    const feePayer = "0x3333333333333333333333333333333333333333"
    const encoded = encodeTestFeeCalculatorData(
      feeCurrency,
      "10000000000000000",
      feeRecipient,
      feePayer
    )
    const [decodedCurrency, feeBps, decodedRecipient, decodedPayer] =
      decodeAbiParameters(
        parseAbiParameters("uint256, uint256, address, address"),
        encoded as `0x${string}`
      )
    expect(decodedCurrency).toBe(feeCurrency)
    expect(feeBps).toBe(10000000000000000n)
    expect((decodedRecipient as string).toLowerCase()).toBe(feeRecipient)
    expect((decodedPayer as string).toLowerCase()).toBe(feePayer)
  })

  it("uses empty data for the default token-id keyed amount rate limiter", () => {
    expect(actions[3].data.rateLimiterData).toBe("0x")
  })
})
