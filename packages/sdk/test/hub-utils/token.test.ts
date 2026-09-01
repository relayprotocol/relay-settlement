import { describe, expect, test } from "vitest"
import {
  generateTokenId,
  type TokenIdComponents,
} from "../../src/hub/hub-utils"
import { tokenIdTestCases } from "./fixtures/tokenId"

describe("Token ID Generation", () => {
  test.each(tokenIdTestCases)("$name", ({ input, expectedValue }) => {
    const tokenId = generateTokenId(input)

    const differentInput = {
      ...input,
      chainId: input.chainId + 1n,
    }
    const differentTokenId = generateTokenId(differentInput)
    expect(tokenId).not.toBe(differentTokenId)
    expect(tokenId).toBe(expectedValue)
  })

  test("should handle case-insensitive EVM addresses", () => {
    const addr = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    const input1: TokenIdComponents = {
      address: addr,
      chainId: 1n,
      family: "ethereum-vm",
    }
    const input2: TokenIdComponents = {
      address: addr.toLowerCase(),
      chainId: 1n,
      family: "ethereum-vm",
    }

    expect(generateTokenId(input1)).toBe(generateTokenId(input2))
  })

  test("enforces hyperliquid-vm currency length of 16 bytes (SEC-165)", () => {
    expect(() =>
      generateTokenId({
        family: "hyperliquid-vm",
        chainId: "1337",
        address: "0x" + "00".repeat(16),
      })
    ).not.toThrow()

    expect(() =>
      generateTokenId({
        family: "hyperliquid-vm",
        chainId: "1337",
        address: "0x30" + "00".repeat(16),
      })
    ).toThrow(/hyperliquid-vm byte length 17; expected 16/)

    expect(() =>
      generateTokenId({
        family: "hyperliquid-vm",
        chainId: "1337",
        address: "0x" + "11".repeat(20),
      })
    ).toThrow(/hyperliquid-vm byte length 20; expected 16/)
  })
})
