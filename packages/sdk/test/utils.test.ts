import { describe, expect, test } from "vitest"
import { hexToBytes } from "viem"
import {
  decodeAddress,
  encodeAddress,
  encodeBytes,
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
    expect(
      encodeAddress("0x" + "11".repeat(20), "hyperliquid-vm")
    ).toHaveLength(20)
    expect(
      encodeAddress("0x" + "00".repeat(16), "hyperliquid-vm")
    ).toHaveLength(16)
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

describe("hex prefix validation", () => {
  test("encodeBytes rejects un-prefixed hex instead of truncating", () => {
    expect(() => encodeBytes("deadbeef")).toThrow(/0x-prefixed/)
  })

  test("encodeBytes rejects odd-length and non-hex input", () => {
    expect(() => encodeBytes("0xabc")).toThrow(/0x-prefixed/)
    expect(() => encodeBytes("0xzz")).toThrow(/0x-prefixed/)
  })

  test("encodeBytes accepts prefixed and empty hex", () => {
    expect(encodeBytes("0xdeadbeef")).toEqual(hexToBytes("0xdeadbeef"))
    expect(encodeBytes("0x")).toHaveLength(0)
  })

  test("encodeAddress rejects un-prefixed ethereum-vm and hyperliquid-vm addresses", () => {
    const bare = "11".repeat(20)
    expect(() => encodeAddress(bare, "ethereum-vm")).toThrow(/0x-prefixed/)
    expect(() => encodeAddress(bare, "hyperliquid-vm")).toThrow(/0x-prefixed/)
  })
})

describe("address encoding strictness", () => {
  test("rejects a bitcoin base58 address with a bad checksum", () => {
    expect(() =>
      encodeAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", "bitcoin-vm")
    ).toThrow()
  })

  test("rejects a bitcoin base58 address with a non-mainnet version", () => {
    expect(() =>
      encodeAddress("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "bitcoin-vm")
    ).toThrow()
  })

  test("round-trips mainnet P2PKH and P2SH addresses", () => {
    for (const address of [
      "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
      "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    ]) {
      expect(
        decodeAddress(encodeAddress(address, "bitcoin-vm"), "bitcoin-vm")
      ).toBe(address)
    }
  })

  test.each([
    [`0:${"11".repeat(32)}a`, "trailing hex"],
    [`0:${"11".repeat(31)}`, "short hex"],
    [`0x0:${"11".repeat(32)}`, "hex-prefixed workchain"],
    [` 0:${"11".repeat(32)}`, "leading whitespace"],
  ])("rejects malformed raw TON address %s (%s)", (address) => {
    expect(() => encodeAddress(address, "ton-vm")).toThrow(
      /Invalid TON address/
    )
  })

  test("accepts a well-formed raw TON address", () => {
    expect(
      decodeAddress(encodeAddress(`0:${"11".repeat(32)}`, "ton-vm"), "ton-vm")
    ).toBe(`0:${"11".repeat(32)}`)
  })
})
