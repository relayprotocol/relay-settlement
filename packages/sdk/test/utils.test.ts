import { describe, expect, test } from "vitest"
import { hexToBytes } from "viem"
import { decodeAddress, encodeAddressToHex } from "../src/utils"

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
