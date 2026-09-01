import { describe, expect, test } from "vitest"
import { hexToBytes } from "viem"
import {
  decodeAddress,
  encodeAddress,
  encodeAddressToHex,
} from "../src/utils"

describe("address encoding", () => {
  test("keeps bitcoin bech32 v0 encoding unchanged", () => {
    const address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    const encoded = "0x00751e76e8199196d454941c45d1b3a323f1433bd6"

    expect(encodeAddressToHex(address, "bitcoin-vm")).toBe(encoded)
    expect(decodeAddress(hexToBytes(encoded), "bitcoin-vm")).toBe(address)
  })

  test("keeps bitcoin native currency sentinel encoding unchanged", () => {
    const address = "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8"
    const encoded = "0x0000000000000000000000000000000000000000"

    expect(encodeAddressToHex(address, "bitcoin-vm")).toBe(encoded)
    expect(decodeAddress(hexToBytes(encoded), "bitcoin-vm")).toBe(address)
  })

  test("adds a discriminator to bitcoin P2PKH encoding", () => {
    const address = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
    const encoded = "0xff0062e907b15cbf27d5425399ebf6f0fb50ebb88f18"

    expect(encodeAddressToHex(address, "bitcoin-vm")).toBe(encoded)
    expect(decodeAddress(hexToBytes(encoded), "bitcoin-vm")).toBe(address)
  })

  test("adds a discriminator to bitcoin P2SH encoding", () => {
    const address = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
    const encoded = "0xff05b472a266d0bd89c13706a4132ccfb16f7c3b9fcb"

    expect(encodeAddressToHex(address, "bitcoin-vm")).toBe(encoded)
    expect(decodeAddress(hexToBytes(encoded), "bitcoin-vm")).toBe(address)
  })
})

describe("address length validation (SEC-165)", () => {
  test("accepts a canonical 20-byte ethereum-vm address", () => {
    const address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    expect(encodeAddress(address, "ethereum-vm")).toHaveLength(20)
  })

  test("rejects an oversized ethereum-vm address", () => {
    const spoof = "0x30" + "11".repeat(20)
    expect(() => encodeAddress(spoof, "ethereum-vm")).toThrow(
      /ethereum-vm address byte length 21/
    )
  })

  test("rejects a short ethereum-vm address", () => {
    expect(() => encodeAddress("0x1122", "ethereum-vm")).toThrow(
      /ethereum-vm address byte length 2/
    )
  })

  test("accepts a canonical 32-byte solana-vm address", () => {
    const address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    expect(encodeAddress(address, "solana-vm")).toHaveLength(32)
  })

  test("rejects a non-32-byte solana-vm address", () => {
    const address = "1".repeat(45)
    expect(() => encodeAddress(address, "solana-vm")).toThrow(
      /solana-vm address byte length/
    )
  })

  test("accepts hyperliquid-vm identifiers between 1 and 20 bytes", () => {
    expect(encodeAddress("0x" + "11".repeat(20), "hyperliquid-vm")).toHaveLength(
      20
    )
    expect(encodeAddress("0x" + "00".repeat(16), "hyperliquid-vm")).toHaveLength(
      16
    )
  })

  test("rejects an oversized hyperliquid-vm identifier", () => {
    expect(() =>
      encodeAddress("0x" + "11".repeat(21), "hyperliquid-vm")
    ).toThrow(/hyperliquid-vm address byte length 21/)
  })

  test("rejects an empty hyperliquid-vm identifier", () => {
    expect(() => encodeAddress("0x", "hyperliquid-vm")).toThrow(
      /hyperliquid-vm address byte length 0/
    )
  })
})
