// ABOUTME: Accept/reject and byte-compatibility tests for the canonical Lighter
// ABOUTME: account-index codec in src/lighter-vm.ts and the lighter-vm cases in src/utils.ts.

import { describe, expect, test } from "vitest"
import { hexToBytes } from "viem"

import {
  formatLighterAccountIndex,
  LIGHTER_ACCOUNT_INDEX_MAX,
  parseLighterAccountIndex,
} from "../src/lighter-vm"
import {
  decodeAddress,
  encodeAddress,
  encodeAddressToHex,
  getVmTypeNativeCurrency,
} from "../src/utils"

// The pre-parser encoding every signed order committed to; canonical indices
// must keep encoding identically or in-flight order ids change.
const legacyEncodeAddressToHex = (address: string) =>
  `0x${Number(address).toString(16).padStart(32, "0")}`

describe("lighter-vm account index parsing", () => {
  test.each([
    ["0", 0n],
    ["42", 42n],
    ["508431", 508431n],
    [LIGHTER_ACCOUNT_INDEX_MAX.toString(), LIGHTER_ACCOUNT_INDEX_MAX],
  ])("accepts %s and round-trips it", (value, expected) => {
    expect(parseLighterAccountIndex(value)).toBe(expected)
    expect(formatLighterAccountIndex(parseLighterAccountIndex(value))).toBe(
      value
    )
  })

  test.each([
    ["50843.1e1", "exponent notation (Number reads 508431, parseInt 50843)"],
    ["1e3", "exponent notation"],
    ["4.2", "decimal point"],
    ["0x1f", "hex prefix"],
    ["+42", "leading sign"],
    ["-1", "negative"],
    [" 42", "leading whitespace"],
    ["42 ", "trailing whitespace"],
    ["042", "leading zero"],
    ["42abc", "trailing characters"],
    ["abc42", "leading characters"],
    ["1_000", "numeric separator"],
    ["", "empty string"],
    [(LIGHTER_ACCOUNT_INDEX_MAX + 1n).toString(), "above the uint48 maximum"],
  ])("rejects %s (%s)", (value) => {
    expect(() => parseLighterAccountIndex(value)).toThrow(
      /Invalid Lighter account index/
    )
  })

  test("rejects formatting a value outside the account index range", () => {
    expect(() => formatLighterAccountIndex(-1n)).toThrow(
      /Invalid Lighter account index/
    )
    expect(() =>
      formatLighterAccountIndex(LIGHTER_ACCOUNT_INDEX_MAX + 1n)
    ).toThrow(/Invalid Lighter account index/)
  })
})

describe("lighter-vm address encoding", () => {
  test("encodes the account index as a 16-byte big-endian integer", () => {
    expect(encodeAddress("508431", "lighter-vm")).toHaveLength(16)
    expect(encodeAddressToHex("508431", "lighter-vm")).toBe(
      "0x0000000000000000000000000007c20f"
    )
  })

  test("keeps the native currency sentinel encoding unchanged", () => {
    expect(
      encodeAddressToHex(getVmTypeNativeCurrency("lighter-vm"), "lighter-vm")
    ).toBe(`0x${"00".repeat(16)}`)
  })

  test("matches the legacy Number encoding for every canonical index", () => {
    const samples = [
      "0",
      "1",
      "42",
      "50843",
      "508431",
      "73094",
      "730948",
      "460491",
      "466324",
      (2n ** 32n).toString(),
      (2n ** 53n - 1n).toString(),
      LIGHTER_ACCOUNT_INDEX_MAX.toString(),
    ].filter((value) => BigInt(value) <= LIGHTER_ACCOUNT_INDEX_MAX)
    // Deterministic 64-bit LCG sweep over the whole uint48 range
    let state = 0x2545f4914f6cdd1dn
    for (let i = 0; i < 5000; i++) {
      state =
        (state * 6364136223846793005n + 1442695040888963407n) &
        ((1n << 64n) - 1n)
      samples.push(((state >> 16n) & LIGHTER_ACCOUNT_INDEX_MAX).toString())
    }

    for (const value of samples) {
      expect(encodeAddressToHex(value, "lighter-vm")).toBe(
        legacyEncodeAddressToHex(value)
      )
    }
  })

  test.each(["50843.1e1", "1e3", "0x1f", " 42", "+42", "042", ""])(
    "rejects the alias %s that the legacy encoding accepted",
    (value) => {
      expect(() => encodeAddress(value, "lighter-vm")).toThrow(
        /Invalid Lighter account index/
      )
    }
  )

  test("round-trips through decodeAddress", () => {
    for (const value of [
      "0",
      "42",
      "508431",
      LIGHTER_ACCOUNT_INDEX_MAX.toString(),
    ]) {
      expect(
        decodeAddress(encodeAddress(value, "lighter-vm"), "lighter-vm")
      ).toBe(value)
    }
  })

  test("rejects decoding bytes above the account index range", () => {
    // 2^48, one above the uint48 maximum, in the 16-byte slot
    const bytes = hexToBytes(`0x${"00".repeat(9)}01${"00".repeat(6)}`)
    expect(() => decodeAddress(bytes, "lighter-vm")).toThrow(
      /Invalid Lighter account index/
    )
  })
})
