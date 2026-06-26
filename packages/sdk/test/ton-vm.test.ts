// ABOUTME: Round-trip tests for ton-vm codecs in src/utils.ts
// ABOUTME: 32-byte hash-only encoding (bytes32 order slot); workchain is chain-level, non-basechain inputs rejected.

import { Address as TonAddress } from "@ton/core"
import { describe, expect, test } from "vitest"

import {
  decodeAddress,
  decodeTransactionId,
  encodeAddress,
  encodeTransactionId,
  getVmTypeNativeCurrency,
} from "../src/utils"

const HASH_HEX_A =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
const HASH_HEX_B =
  "1122334455667788990011223344556677889900112233445566778899001122"
const HASH_HEX_ZERO =
  "0000000000000000000000000000000000000000000000000000000000000000"

const friendlyForms = (hashHex: string) => {
  const addr = new TonAddress(0, Buffer.from(hashHex, "hex"))
  return {
    raw: addr.toRawString(),
    bounceableUrl: addr.toString({ urlSafe: true, bounceable: true }),
    nonBounceableUrl: addr.toString({ urlSafe: true, bounceable: false }),
    bounceableB64: addr.toString({ urlSafe: false, bounceable: true }),
  }
}

describe("ton-vm encodeAddress / decodeAddress", () => {
  test.each([HASH_HEX_A, HASH_HEX_B, HASH_HEX_ZERO])(
    "round-trips raw form for hash %s",
    (hashHex) => {
      const { raw } = friendlyForms(hashHex)
      const bytes = encodeAddress(raw, "ton-vm")
      expect(Buffer.from(bytes).toString("hex")).toBe(hashHex)
      expect(decodeAddress(bytes, "ton-vm")).toBe(raw)
    }
  )

  test("accepts friendly bounceable url-safe form on encode", () => {
    const { raw, bounceableUrl } = friendlyForms(HASH_HEX_A)
    const bytes = encodeAddress(bounceableUrl, "ton-vm")
    expect(Buffer.from(bytes).toString("hex")).toBe(HASH_HEX_A)
    expect(decodeAddress(bytes, "ton-vm")).toBe(raw)
  })

  test("accepts friendly non-bounceable url-safe form on encode", () => {
    const { raw, nonBounceableUrl } = friendlyForms(HASH_HEX_B)
    const bytes = encodeAddress(nonBounceableUrl, "ton-vm")
    expect(Buffer.from(bytes).toString("hex")).toBe(HASH_HEX_B)
    expect(decodeAddress(bytes, "ton-vm")).toBe(raw)
  })

  test("accepts friendly bounceable base64 (non-url-safe) form on encode", () => {
    const { raw, bounceableB64 } = friendlyForms(HASH_HEX_A)
    const bytes = encodeAddress(bounceableB64, "ton-vm")
    expect(decodeAddress(bytes, "ton-vm")).toBe(raw)
  })

  test("rejects masterchain (workchain -1) addresses — chain/address workchain mismatch", () => {
    const masterchain = new TonAddress(
      -1,
      Buffer.from(HASH_HEX_A, "hex")
    ).toRawString()
    expect(() => encodeAddress(masterchain, "ton-vm")).toThrow(/workchain/i)
  })

  test("rejects malformed input strings", () => {
    expect(() => encodeAddress("not-an-address", "ton-vm")).toThrow()
  })

  test("decodeAddress rejects non-32-byte input", () => {
    expect(() => decodeAddress(new Uint8Array(31), "ton-vm")).toThrow(/length/i)
    expect(() => decodeAddress(new Uint8Array(33), "ton-vm")).toThrow(/length/i)
  })

  test("testOnly friendly form decodes to the same 32-byte hash as mainnet form", () => {
    // testOnly is a friendly-encoding network hint, not part of the on-chain
    // representation; mainnet/testnet separation is enforced via chainId, not
    // address codec.
    const addr = new TonAddress(0, Buffer.from(HASH_HEX_A, "hex"))
    const testnetFriendly = addr.toString({
      urlSafe: true,
      bounceable: true,
      testOnly: true,
    })
    const bytes = encodeAddress(testnetFriendly, "ton-vm")
    expect(Buffer.from(bytes).toString("hex")).toBe(HASH_HEX_A)
  })

  test("accepts uppercase raw form on encode and canonicalizes to lowercase on decode", () => {
    const upper = `0:${HASH_HEX_A.toUpperCase()}`
    const bytes = encodeAddress(upper, "ton-vm")
    expect(Buffer.from(bytes).toString("hex")).toBe(HASH_HEX_A)
    expect(decodeAddress(bytes, "ton-vm")).toBe(`0:${HASH_HEX_A}`)
  })
})

describe("ton-vm encodeTransactionId / decodeTransactionId", () => {
  test.each([HASH_HEX_A, HASH_HEX_B, HASH_HEX_ZERO])(
    "round-trips hash %s as bare hex",
    (hashHex) => {
      const bytes = encodeTransactionId(hashHex, "ton-vm")
      expect(bytes).toHaveLength(32)
      expect(Buffer.from(bytes).toString("hex")).toBe(hashHex)
      expect(decodeTransactionId(bytes, "ton-vm")).toBe(hashHex)
    }
  )

  test("rejects short hex (would silently zero-pad without the length check)", () => {
    expect(() => encodeTransactionId("deadbeef", "ton-vm")).toThrow(/length/i)
  })

  test("rejects 63-char (odd-length) hex", () => {
    expect(() => encodeTransactionId("a".repeat(63), "ton-vm")).toThrow(
      /length/i
    )
  })

  test("rejects 0x-prefixed input (callers must pass bare hex)", () => {
    expect(() => encodeTransactionId(`0x${HASH_HEX_A}`, "ton-vm")).toThrow(
      /length/i
    )
  })
})

describe("ton-vm native currency", () => {
  test("returns friendly bouncable zero-address sentinel", () => {
    // String form must match the friendly zero-address used as the native
    // sentinel across the TON stack (solver TONVM_NATIVE_CURRENCY, ton-vm
    // wrapper ADDRESS_NONE). Encoded form must still be 32 zero bytes —
    // the canonical contract-side representation of workchain-0 / hash 0.
    const native = getVmTypeNativeCurrency("ton-vm")
    expect(native).toBe("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c")
    const bytes = encodeAddress(native, "ton-vm")
    expect(Buffer.from(bytes).toString("hex")).toBe(HASH_HEX_ZERO)
  })
})
