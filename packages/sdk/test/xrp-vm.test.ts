// ABOUTME: Round-trip tests for xrp-vm codecs in src/utils.ts
// ABOUTME: 20-byte AccountID address encoding, 32-byte uppercase-hex tx ids, native XRP sentinel.

import {
  classicAddressToXAddress,
  encodeAccountID,
} from "ripple-address-codec"
import { describe, expect, test } from "vitest"

import {
  decodeAddress,
  decodeTransactionId,
  decodeXrpDestination,
  encodeAddress,
  encodeTransactionId,
  getVmTypeNativeCurrency,
} from "../src/utils"

const ACCT_HEX_A = "5e7b112523f68d2f5e879db4eac51c6698a69304"
const ACCT_HEX_B = "b5f762798a53d543a014caf8b297cff8f2f937e8"
const ACCT_HEX_ZERO = "0000000000000000000000000000000000000000"

const classicAddress = (hex: string) =>
  encodeAccountID(Buffer.from(hex, "hex"))

describe("xrp-vm encodeAddress / decodeAddress", () => {
  test.each([ACCT_HEX_A, ACCT_HEX_B, ACCT_HEX_ZERO])(
    "round-trips classic address for account %s",
    (hex) => {
      const address = classicAddress(hex)
      const bytes = encodeAddress(address, "xrp-vm")
      expect(bytes).toHaveLength(20)
      expect(Buffer.from(bytes).toString("hex")).toBe(hex)
      expect(decodeAddress(bytes, "xrp-vm")).toBe(address)
    }
  )

  test("accepts an X-address with no tag and maps it to the classic account", () => {
    const address = classicAddress(ACCT_HEX_A)
    const xAddress = classicAddressToXAddress(address, false, false)
    const bytes = encodeAddress(xAddress, "xrp-vm")
    expect(Buffer.from(bytes).toString("hex")).toBe(ACCT_HEX_A)
    // Decoding always yields the classic form; the X-address wrapper is dropped.
    expect(decodeAddress(bytes, "xrp-vm")).toBe(address)
  })

  test("rejects an X-address that carries a destination tag", () => {
    const address = classicAddress(ACCT_HEX_A)
    const taggedXAddress = classicAddressToXAddress(address, 42, false)
    expect(() => encodeAddress(taggedXAddress, "xrp-vm")).toThrow(
      /destination tag/i
    )
  })

  test("rejects a malformed address", () => {
    expect(() => encodeAddress("not-an-xrp-address", "xrp-vm")).toThrow(
      /invalid xrp address/i
    )
  })

  test("rejects a classic address with a corrupted checksum", () => {
    const address = classicAddress(ACCT_HEX_A)
    const corrupted = address.slice(0, -1) + (address.endsWith("a") ? "b" : "a")
    expect(() => encodeAddress(corrupted, "xrp-vm")).toThrow(
      /invalid xrp address/i
    )
  })

  test("decodeAddress rejects non-20-byte input", () => {
    expect(() => decodeAddress(new Uint8Array(19), "xrp-vm")).toThrow(/length/i)
    expect(() => decodeAddress(new Uint8Array(21), "xrp-vm")).toThrow(/length/i)
  })
})

describe("xrp-vm encodeTransactionId / decodeTransactionId", () => {
  const TXID_UPPER =
    "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899"

  test("round-trips a 64-char hash as canonical uppercase hex", () => {
    const bytes = encodeTransactionId(TXID_UPPER, "xrp-vm")
    expect(bytes).toHaveLength(32)
    expect(decodeTransactionId(bytes, "xrp-vm")).toBe(TXID_UPPER)
  })

  test("accepts lowercase input and canonicalizes to uppercase on decode", () => {
    const bytes = encodeTransactionId(TXID_UPPER.toLowerCase(), "xrp-vm")
    expect(decodeTransactionId(bytes, "xrp-vm")).toBe(TXID_UPPER)
  })

  test("rejects short hex (would silently zero-pad without the length check)", () => {
    expect(() => encodeTransactionId("deadbeef", "xrp-vm")).toThrow(/64 hex/i)
  })

  test("rejects 63-char (odd-length) hex", () => {
    expect(() => encodeTransactionId("a".repeat(63), "xrp-vm")).toThrow(
      /64 hex/i
    )
  })

  test("rejects 0x-prefixed input (callers must pass bare hex)", () => {
    expect(() => encodeTransactionId(`0x${TXID_UPPER}`, "xrp-vm")).toThrow(
      /64 hex/i
    )
  })
})

describe("xrp-vm native currency", () => {
  test("returns the ACCOUNT_ZERO sentinel that encodes to 20 zero bytes", () => {
    const native = getVmTypeNativeCurrency("xrp-vm")
    expect(native).toBe("rrrrrrrrrrrrrrrrrrrrrhoLvTp")
    const bytes = encodeAddress(native, "xrp-vm")
    expect(Buffer.from(bytes).toString("hex")).toBe(ACCT_HEX_ZERO)
  })
})

describe("xrp-vm decodeXrpDestination", () => {
  test("returns a classic address unchanged with no tag", () => {
    const address = classicAddress(ACCT_HEX_A)
    expect(decodeXrpDestination(address)).toEqual({ account: address })
  })

  test("maps an untagged X-address to its classic account with no tag", () => {
    const address = classicAddress(ACCT_HEX_A)
    const xAddress = classicAddressToXAddress(address, false, false)
    expect(decodeXrpDestination(xAddress)).toEqual({ account: address })
  })

  test("extracts the destination tag from a tagged X-address", () => {
    const address = classicAddress(ACCT_HEX_A)
    const xAddress = classicAddressToXAddress(address, 305419896, false)
    expect(decodeXrpDestination(xAddress)).toEqual({
      account: address,
      tag: 305419896,
    })
  })

  test("preserves a destination tag of 0 (distinct from no tag)", () => {
    const address = classicAddress(ACCT_HEX_A)
    const xAddress = classicAddressToXAddress(address, 0, false)
    expect(decodeXrpDestination(xAddress)).toEqual({ account: address, tag: 0 })
  })

  test("rejects a malformed address", () => {
    expect(() => decodeXrpDestination("not-an-xrp-address")).toThrow(
      /invalid xrp address/i
    )
  })
})
