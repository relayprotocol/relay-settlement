import { decodeAbiParameters, getAddress, parseAbiParameters } from "viem"
import { describe, it, expect } from "vitest"

import { VmType } from "../src"
import {
  getSubmitWithdrawRequestHash,
  getWithdrawalAddress,
  getWithdrawalAddressSafe,
  normalizePayloadParams,
} from "../src/messages/v2.2/withdrawal"

describe("getWithdrawalAddress (V1)", () => {
  it("should return a valid withdrawal address", () => {
    const params = {
      depository: "0x1234567890123456789012345678901234567890",
      chainId: "ethereum",
      vmType: "ethereum-vm" as VmType,
      currency: "10340230",
      recipient: "0x9876543210987654321098765432109876543210",
      ownerAlias: "0x9876543210987654321098765432109876543210",
      nonce: "0",
    }

    const address = getWithdrawalAddress(params)
    expect(address).toMatch(/^0x[0-9a-f]{40}$/i)
    expect(address).toBe("0x1c1b40f43b18c2ff894a1bd8f1d13e0b1e92af0a")
    expect(getAddress(address).toLowerCase()).toMatch(address)
  })
})

describe("getWithdrawalAddressSafe", () => {
  it("should return a valid withdrawal address", () => {
    const params = {
      depository: "0x1234567890123456789012345678901234567890",
      chainId: "ethereum",
      vmType: "ethereum-vm" as VmType,
      currency: "10340230",
      recipient: "0x9876543210987654321098765432109876543210",
      ownerAlias: "0x9876543210987654321098765432109876543210",
      nonce: "0",
      additionalData: "0x",
    }

    const address = getWithdrawalAddressSafe(params)
    expect(address).toMatch(/^0x[0-9a-f]{40}$/i)
    expect(address).toBe("0x33c0f512a96421f8c90368768733b3541e0aa9b6")
    expect(getAddress(address).toLowerCase()).toMatch(address)
  })

  it("should produce a different address than V1 for the same inputs", () => {
    const baseParams = {
      depository: "0x1234567890123456789012345678901234567890",
      chainId: "ethereum",
      vmType: "ethereum-vm" as VmType,
      currency: "10340230",
      recipient: "0x9876543210987654321098765432109876543210",
      ownerAlias: "0x9876543210987654321098765432109876543210",
      nonce: "0",
    }

    const v1Address = getWithdrawalAddress(baseParams)
    const v2Address = getWithdrawalAddressSafe({
      ...baseParams,
      additionalData: "0x",
    })
    expect(v1Address).not.toBe(v2Address)
  })
})
describe("normalizePayloadParams (lighter-vm)", () => {
  it("should encode lighter-vm additionalData into data field matching PayloadBuilder ABI", () => {
    const result = normalizePayloadParams({
      chainId: "304",
      depository: "42",
      currency: "3",
      amount: "2000000",
      spender: "0xFD3E80587416B94Ef6D9394b323d8E47699d073E",
      recipient: "99",
      nonce:
        "0x9400f1b21cb527d7fa3d3eabba93557a18ebe7a2ca4e471cfe5e4c5b4ca7f767",
      vmType: "lighter-vm" as VmType,
      additionalData: {
        "lighter-vm": {
          nonce: 1,
          fromRouteType: 0,
          toRouteType: 1,
          apiKeyIndex: 5,
          usdcFee: 100,
          memo: "abcd1234",
        },
      },
    })

    // Decode data to verify it matches PayloadBuilder._decodeTransferData ABI:
    // (uint8, uint64, uint64, uint64, uint64, uint64, bytes32)
    const decoded = decodeAbiParameters(
      parseAbiParameters(
        "uint8, uint64, uint64, uint64, uint64, uint64, bytes32"
      ),
      result.data as `0x${string}`
    )

    expect(decoded[0]).toBe(0) // actionType = Transfer
    expect(decoded[1]).toBe(1n) // nonce
    expect(decoded[2]).toBe(0n) // fromRouteType
    expect(decoded[3]).toBe(1n) // toRouteType
    expect(decoded[4]).toBe(5n) // apiKeyIndex
    expect(decoded[5]).toBe(100n) // usdcFee
    // memo: "abcd1234" padded to 64 hex chars → bytes32
    expect(decoded[6]).toBe(
      "0xabcd123400000000000000000000000000000000000000000000000000000000"
    )
  })

  it("should handle memo with 0x prefix", () => {
    const result = normalizePayloadParams({
      chainId: "304",
      depository: "42",
      currency: "3",
      amount: "1000000",
      spender: "0xFD3E80587416B94Ef6D9394b323d8E47699d073E",
      recipient: "99",
      nonce: "0x01",
      vmType: "lighter-vm" as VmType,
      additionalData: {
        "lighter-vm": {
          nonce: 10,
          fromRouteType: 0,
          toRouteType: 0,
          apiKeyIndex: 4,
          usdcFee: 0,
          memo: "0xdeadbeef",
        },
      },
    })

    const decoded = decodeAbiParameters(
      parseAbiParameters(
        "uint8, uint64, uint64, uint64, uint64, uint64, bytes32"
      ),
      result.data as `0x${string}`
    )

    expect(decoded[6]).toBe(
      "0xdeadbeef00000000000000000000000000000000000000000000000000000000"
    )
  })

  it("should encode empty memo as bytes32(0)", () => {
    const result = normalizePayloadParams({
      chainId: "304",
      depository: "42",
      currency: "3",
      amount: "1000000",
      spender: "0xFD3E80587416B94Ef6D9394b323d8E47699d073E",
      recipient: "99",
      nonce: "0x01",
      vmType: "lighter-vm" as VmType,
      additionalData: {
        "lighter-vm": {
          nonce: 1,
          fromRouteType: 0,
          toRouteType: 0,
          apiKeyIndex: 5,
          usdcFee: 0,
          memo: "",
        },
      },
    })

    const decoded = decodeAbiParameters(
      parseAbiParameters(
        "uint8, uint64, uint64, uint64, uint64, uint64, bytes32"
      ),
      result.data as `0x${string}`
    )

    expect(decoded[6]).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
  })

  it("should throw when memo exceeds 32 bytes", () => {
    expect(() =>
      normalizePayloadParams({
        chainId: "304",
        depository: "42",
        currency: "3",
        amount: "1000000",
        spender: "0xFD3E80587416B94Ef6D9394b323d8E47699d073E",
        recipient: "99",
        nonce: "0x01",
        vmType: "lighter-vm" as VmType,
        additionalData: {
          "lighter-vm": {
            nonce: 1,
            fromRouteType: 0,
            toRouteType: 0,
            apiKeyIndex: 5,
            usdcFee: 0,
            memo: "a".repeat(66), // 33 bytes > 32
          },
        },
      })
    ).toThrow("Lighter memo exceeds 32 bytes")
  })

  it("should throw when lighter-vm additionalData is missing", () => {
    expect(() =>
      normalizePayloadParams({
        chainId: "304",
        depository: "42",
        currency: "3",
        amount: "1000000",
        spender: "0xFD3E80587416B94Ef6D9394b323d8E47699d073E",
        recipient: "99",
        nonce: "0x01",
        vmType: "lighter-vm" as VmType,
      })
    ).toThrow("Additional data is required for lighter-vm")
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
      recipient: "0xfd073a9ccb34f8a13c466eb16dff990d6178a5ef",
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
