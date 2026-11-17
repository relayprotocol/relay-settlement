// ABOUTME: Accept/reject and byte-layout tests for the Atlas asset id codec in
// ABOUTME: src/atlas-vm.ts and the atlas-vm address/currency cases in src/utils.ts.

import { describe, expect, test } from "vitest"
import { concat, Hex, keccak256, pad, stringToHex, toHex } from "viem"

import {
  ATLAS_ASSET_ID_MAX,
  formatAtlasAssetId,
  parseAtlasAssetId,
} from "../src/atlas-vm"
import {
  decodeAddress,
  encodeAddress,
  encodeAddressToHex,
  getVmTypeNativeCurrency,
} from "../src/utils"
import { getWithdrawalCodec } from "../src/messages/v2.1/withdrawals"
import {
  decodeWithdrawal,
  encodeWithdrawal,
  getDecodedWithdrawalId,
} from "../src/messages/v2.1/depository-withdrawal"
import { normalizeWithdrawRequest } from "../src/messages/v2.3/withdrawal"

// Testnet account: a Main account's address is its owner key's address
const ACCOUNT = "0xf2c0fdc5b19482cd485b70749d147074a903b9e1"

describe("atlas-vm asset id parsing", () => {
  test.each([
    ["0", 0n],
    ["2", 2n],
    [ATLAS_ASSET_ID_MAX.toString(), ATLAS_ASSET_ID_MAX],
  ])("accepts %s and round-trips it", (value, expected) => {
    expect(parseAtlasAssetId(value)).toBe(expected)
    expect(formatAtlasAssetId(parseAtlasAssetId(value))).toBe(value)
  })

  test.each([
    ["1.9e37", "exponent notation"],
    ["4.2", "decimal point"],
    ["+42", "leading sign"],
    ["-1", "negative"],
    [" 42", "leading whitespace"],
    ["042", "leading zero"],
    ["42abc", "trailing characters"],
    ["", "empty string"],
    [(ATLAS_ASSET_ID_MAX + 1n).toString(), "above the uint32 maximum"],
  ])("rejects %s (%s)", (value) => {
    expect(() => parseAtlasAssetId(value)).toThrow(/Invalid Atlas asset id/)
  })

  test("rejects formatting a value outside the uint32 range", () => {
    expect(() => formatAtlasAssetId(-1n)).toThrow(/Invalid Atlas asset id/)
    expect(() => formatAtlasAssetId(ATLAS_ASSET_ID_MAX + 1n)).toThrow(
      /Invalid Atlas asset id/
    )
  })
})

describe("atlas-vm address encoding", () => {
  test("encodes an account address as its 20 bytes", () => {
    expect(encodeAddress(ACCOUNT, "atlas-vm")).toHaveLength(20)
    expect(encodeAddressToHex(ACCOUNT, "atlas-vm")).toBe(ACCOUNT)
    expect(decodeAddress(encodeAddress(ACCOUNT, "atlas-vm"), "atlas-vm")).toBe(
      ACCOUNT
    )
  })

  test("decodes a mixed-case account address to lowercase", () => {
    const mixed = `0x${ACCOUNT.slice(2).toUpperCase()}`
    expect(decodeAddress(encodeAddress(mixed, "atlas-vm"), "atlas-vm")).toBe(
      ACCOUNT
    )
  })

  test("encodes the USDT asset id and the native sentinel in 16 bytes", () => {
    expect(encodeAddressToHex("2", "atlas-vm")).toBe(`0x${"00".repeat(15)}02`)
    expect(
      encodeAddressToHex(getVmTypeNativeCurrency("atlas-vm"), "atlas-vm")
    ).toBe(`0x${"00".repeat(16)}`)
    expect(decodeAddress(encodeAddress("2", "atlas-vm"), "atlas-vm")).toBe("2")
  })

  test.each([
    [`${ACCOUNT}00`, "21-byte hex"],
    [ACCOUNT.slice(0, 40), "19-byte hex"],
    ["0x", "empty hex"],
    [`0x${"zz".repeat(20)}`, "non-hex digits"],
    [ACCOUNT.slice(2), "unprefixed hex"],
  ])("rejects encoding %s (%s)", (value) => {
    expect(() => encodeAddress(value, "atlas-vm")).toThrow(/Invalid/)
  })

  test.each([0, 15, 17, 21, 32])("rejects decoding %i bytes", (length) => {
    expect(() => decodeAddress(new Uint8Array(length), "atlas-vm")).toThrow(
      /Invalid atlas-vm address byte length/
    )
  })
})

// Atlas testnet transaction domain: chain id 43003 under keccak256("atlas/testnet")
const TESTNET_DOMAIN_SALT =
  "0xcc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338"

// abi.encode(AtlasPayloadHeader, AtlasTransfer); the payload builder test pins the same
// bytes and transfer id. No transfer Atlas booked under the Nov 9 type string exists yet.
const PAYLOAD = `0x${[
  "000000000000000000000000000000000000000000000000000000000000a7fb",
  "cc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338",
  "0000000000000000000000001ef18983e5ba8d8f36c0bad4543588b8c28e70bd",
  "0000000000000000000000000000000000000000000000000000000000000007",
  "000000000000000000000000000000000000000000000000000000006553ff10",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000001ef18983e5ba8d8f36c0bad4543588b8c28e70bd",
  "000000000000000000000000299d292ddb5c386bee485ed5ffc9226421ed2947",
  "0000000000000000000000000000000000000000000000000000000000000002",
  "000000000000000000000000000000000000000000000000000000e8d4a51000",
  "6f72642d34320000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000007",
].join("")}`
const TRANSFER_ID =
  "0x7b533dfc4b8b8bbb898f8c7291a32983c3dbec4bff489c705c4b3a223c2c4c6f"
// A payload of the Oct 29 release: the same header without `expiresAt`
const PRE_GAPLESS_PAYLOAD = `0x${[
  "0000000000000000000000000000000000000000000000000000000000000001",
  "cc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338",
  "0000000000000000000000008f3a6c1e2b9d4f7a0c5e8b1d3f6a9c2e4b7d0f15",
  "00000000000000000000000000000000000000000000000006861ab120000000",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000008f3a6c1e2b9d4f7a0c5e8b1d3f6a9c2e4b7d0f15",
  "00000000000000000000000071d4b8e2a5c9f3b6d0e7a1c4f8b2d5e9a3c6f0b4",
  "0000000000000000000000000000000000000000000000000000000000000002",
  "00000000000000000000000000000000000000000000000000002d79883d2000",
  "6f72642d34320000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000000",
].join("")}`

describe("atlas-vm withdrawals", () => {
  const DEPOSITORY = "0x1ef18983e5ba8d8f36c0bad4543588b8c28e70bd"
  const withdrawal = {
    domainChainId: "43003",
    domainSalt: TESTNET_DOMAIN_SALT,
    signer: DEPOSITORY,
    nonce: "7",
    expiresAt: "1700003600",
    actionType: 0,
    parameters: {
      type: "Transfer" as const,
      fromAccountAddress: DEPOSITORY,
      toAccountAddress: "0x299d292ddb5c386bee485ed5ffc9226421ed2947",
      assetId: "2",
      amount: "1000000000000",
      memoHead: `0x${Buffer.from("ord-42").toString("hex").padEnd(64, "0")}`,
      memoTail: `0x${"00".repeat(31)}07`,
    },
  }
  const codec = getWithdrawalCodec("atlas-vm")

  const NONCE_TYPE = "NonceGapless(uint64 gapless_nonce,uint64 expires_at)"
  const TRANSFER_TYPE =
    "Transfer(address account,address toAccount,uint32 asset,int128 amount,bytes32 memoHead,bytes32 memoTail)"
  const TRANSACTION_TYPE = `Transaction(address signer,NonceGapless nonce,Transfer action)${NONCE_TYPE}${TRANSFER_TYPE}`
  const typeHash = (type: string) => keccak256(stringToHex(type))
  const word = (value: bigint | string) =>
    pad(toHex(BigInt(value)), { size: 32 })

  // The digest built word by word from the published type string, apart from the codec
  const digestFromTypeString = (w: typeof withdrawal) => {
    const domainSeparator = keccak256(
      concat([
        typeHash(
          "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)"
        ),
        typeHash("atlas"),
        typeHash("1"),
        word(w.domainChainId),
        w.domainSalt as Hex,
      ])
    )
    const structHash = keccak256(
      concat([
        typeHash(TRANSACTION_TYPE),
        word(w.signer),
        keccak256(
          concat([typeHash(NONCE_TYPE), word(w.nonce), word(w.expiresAt)])
        ),
        keccak256(
          concat([
            typeHash(TRANSFER_TYPE),
            word(w.parameters.fromAccountAddress),
            word(w.parameters.toAccountAddress),
            word(w.parameters.assetId),
            word(w.parameters.amount),
            w.parameters.memoHead as Hex,
            w.parameters.memoTail as Hex,
          ])
        ),
      ])
    )
    return {
      domainSeparator,
      digest: keccak256(concat(["0x1901", domainSeparator, structHash])),
    }
  }

  test("encodes like the payload builder and decodes back", () => {
    expect(encodeWithdrawal({ vmType: "atlas-vm", withdrawal })).toBe(PAYLOAD)
    expect((PAYLOAD.length - 2) / 2).toBe(12 * 32)
    expect(decodeWithdrawal(PAYLOAD, "atlas-vm").withdrawal).toEqual(withdrawal)
  })

  test("signs the published Transfer type under the testnet domain separator", () => {
    expect(typeHash(TRANSACTION_TYPE)).toBe(
      "0x3b16569076c858403f01465d87aa7c6c0cee1cafa3cd06e1fc7c723a12b32451"
    )
    const { domainSeparator, digest } = digestFromTypeString(withdrawal)
    expect(domainSeparator).toBe(
      "0x36eae64833f6eada523640b1daaaf695321506d7d8572379f88b0ba8e38ca9ef"
    )
    expect(getDecodedWithdrawalId(decodeWithdrawal(PAYLOAD, "atlas-vm"))).toBe(
      digest
    )
    expect(digest).toBe(TRANSFER_ID)
  })

  test.each([
    ["signer", ACCOUNT],
    ["domainSalt", `0x${"00".repeat(32)}`],
    ["domainChainId", "21337"],
    ["nonce", "8"],
    ["expiresAt", "1700003601"],
  ] as const)("binds %s into the transfer id", (field, value) => {
    expect(codec.getId({ ...withdrawal, [field]: value })).not.toBe(TRANSFER_ID)
  })

  test.each(["nonce", "expiresAt"] as const)(
    "rejects out-of-range %s",
    (field) => {
      for (const value of ["-1", (1n << 64n).toString()]) {
        const invalid = { ...withdrawal, [field]: value }
        expect(() => codec.encode(invalid)).toThrow()
        expect(() => codec.getId(invalid)).toThrow()
      }
    }
  )

  test("rejects payloads built before the gapless release", () => {
    expect(() => decodeWithdrawal(PRE_GAPLESS_PAYLOAD, "atlas-vm")).toThrow(
      "Failed to decode atlas-vm payload"
    )
  })

  test("exposes the signed amount, asset id and receiver", () => {
    expect(codec.getAmount(withdrawal)).toBe("1000000000000")
    expect(codec.getCurrency(withdrawal)).toBe("2")
    expect(codec.getRecipient(withdrawal)).toBe(
      withdrawal.parameters.toAccountAddress
    )
  })

  test("rejects other action types and extra trailing words", () => {
    expect(() =>
      codec.decode(codec.encode({ ...withdrawal, actionType: 1 }))
    ).toThrow("Unsupported Atlas action type: 1")
    expect(() => codec.decode(`${PAYLOAD}${"00".repeat(32)}`)).toThrow(
      "Failed to decode atlas-vm payload"
    )
  })
})

describe("atlas-vm withdraw requests", () => {
  const request = {
    vmType: "atlas-vm",
    chainId: "atlas-testnet",
    depository: ACCOUNT,
    currency: "2",
    amount: "1000000",
    spenderVmType: "ethereum-vm",
    spenderChainId: "relay",
    spender: "0x0000000000000000000000000000000000000001",
    receiver: "0x299d292ddb5c386bee485ed5ffc9226421ed2947",
    nonce: `0x${"00".repeat(32)}`,
  } as Parameters<typeof normalizeWithdrawRequest>[0]

  test("normalizes accounts to 20 bytes, the asset id to 16 and the gapless nonce to one word", () => {
    const normalized = normalizeWithdrawRequest({
      ...request,
      additionalData: { "atlas-vm": { nonce: 7 } },
    })

    expect(normalized.depository).toBe(ACCOUNT)
    expect(normalized.currency).toBe(`0x${"00".repeat(15)}02`)
    expect(normalized.receiver).toBe(
      "0x299d292ddb5c386bee485ed5ffc9226421ed2947"
    )
    expect(normalized.data).toBe(`0x${"00".repeat(31)}07`)
  })

  test("requires the gapless nonce", () => {
    expect(() => normalizeWithdrawRequest(request)).toThrow(
      "Additional data is required for atlas-vm"
    )
  })
})
