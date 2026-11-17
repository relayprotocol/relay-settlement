// ABOUTME: Round-trip tests for xrp-vm withdrawal encode/decode + XRPL signing-hash withdrawalId.
// ABOUTME: Reference hashes are the SHA512Half signing hashes the allocator signs; XrpVmPayloadBuilder must match.

import { describe, expect, it } from "vitest"

import {
  decodeWithdrawal,
  DecodedXrpVmWithdrawal,
  encodeWithdrawal,
  getDecodedWithdrawalId,
} from "../src/messages/v2.1/depository-withdrawal"
import { getVmTypeNativeCurrency } from "../src/utils"
import { getWithdrawalCodec } from "../src/messages/v2.1/withdrawals"

const codec = getWithdrawalCodec("xrp-vm")

// Sending depository account (r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59) and receiver
// (rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh). The signing hashes below are
// SHA512Half(0x53545800 || canonical-serialized-tx) computed from the XRPL
// binary codec — the exact value XrpVmPayloadBuilder.hashesToSign must return.
const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59"
const DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
const SIGNING_PUB_KEY =
  "0x0388935426e0d08083314842edfbb2d517bd47699f9a4527318a8e10468c97c052"
// Fixed InvoiceID (sha256("test")) shared with the XrpVmPayloadBuilder vectors
const INVOICE_ID =
  "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

const vectors = [
  {
    label: "V1 typical native XRP payment",
    decoded: {
      account: ACCOUNT,
      destination: DESTINATION,
      amount: "1000000",
      fee: "12",
      sequence: 42,
      lastLedgerSequence: 1000,
      flags: 2147483648,
      signingPubKey: SIGNING_PUB_KEY,
    },
    expectedHash:
      "0xA434EADB919B76BC3A84A284F19BBA69AF15D35533E4211CB4A8E44104C4F007",
  },
  {
    label: "V2 with destination tag 0 (distinct from no tag)",
    decoded: {
      account: ACCOUNT,
      destination: DESTINATION,
      amount: "1",
      fee: "10",
      sequence: 1,
      lastLedgerSequence: 2,
      flags: 0,
      signingPubKey: SIGNING_PUB_KEY,
      destinationTag: 0,
    },
    expectedHash:
      "0xD50DF11A1FAC07E761446DD8C38F07A76A832F21834436676CF3AA6B5E37730D",
  },
  {
    label: "V3 max fields with destination tag",
    decoded: {
      account: ACCOUNT,
      destination: DESTINATION,
      amount: "99999999999999999",
      fee: "1000",
      sequence: 4294967295,
      lastLedgerSequence: 4294967295,
      flags: 2147483648,
      signingPubKey: SIGNING_PUB_KEY,
      destinationTag: 305419896,
    },
    expectedHash:
      "0x9AEA05F716D0042D5987BCBD1F0D11076BE4CEE6B00CE22CD7D5CA525DDF2063",
  },
  {
    label: "V4 = V1 with InvoiceID",
    decoded: {
      account: ACCOUNT,
      destination: DESTINATION,
      amount: "1000000",
      fee: "12",
      sequence: 42,
      lastLedgerSequence: 1000,
      flags: 2147483648,
      signingPubKey: SIGNING_PUB_KEY,
      invoiceId: INVOICE_ID,
    },
    expectedHash:
      "0xC1707ED97EB40E25A303C1D07CF71E35B1AA69CFF2A3140199061E0DE2A27EFB",
  },
  {
    label: "V5 = V2 with InvoiceID",
    decoded: {
      account: ACCOUNT,
      destination: DESTINATION,
      amount: "1",
      fee: "10",
      sequence: 1,
      lastLedgerSequence: 2,
      flags: 0,
      signingPubKey: SIGNING_PUB_KEY,
      destinationTag: 0,
      invoiceId: INVOICE_ID,
    },
    expectedHash:
      "0x8838738B7FE9BC013CD4B2A082656A7FFD221362837CB08F39350D800850D39E",
  },
  {
    label: "V6 = V3 with InvoiceID",
    decoded: {
      account: ACCOUNT,
      destination: DESTINATION,
      amount: "99999999999999999",
      fee: "1000",
      sequence: 4294967295,
      lastLedgerSequence: 4294967295,
      flags: 2147483648,
      signingPubKey: SIGNING_PUB_KEY,
      destinationTag: 305419896,
      invoiceId: INVOICE_ID,
    },
    expectedHash:
      "0xCCEAF04F1DCB462A5509218093E28EFDCCF2A1E364FA296B192B0EF14A33ED5A",
  },
]

// `abi.encode(XrpPaymentRequest)` of V1 from the builder before and after it
// gained `invoiceId` (produced with `cast abi-encode`)
const LEGACY_V1_PAYLOAD =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000020" +
  "5e7b112523f68d2f5e879db4eac51c6698a69304000000000000000000000000" +
  "b5f762798a53d543a014caf8b297cff8f2f937e8000000000000000000000000" +
  "00000000000000000000000000000000000000000000000000000000000f4240" +
  "000000000000000000000000000000000000000000000000000000000000000c" +
  "000000000000000000000000000000000000000000000000000000000000002a" +
  "00000000000000000000000000000000000000000000000000000000000003e8" +
  "0000000000000000000000000000000000000000000000000000000080000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000140" +
  "0000000000000000000000000000000000000000000000000000000000000021" +
  "0388935426e0d08083314842edfbb2d517bd47699f9a4527318a8e10468c97c0" +
  "5200000000000000000000000000000000000000000000000000000000000000"
const V4_PAYLOAD =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000020" +
  "5e7b112523f68d2f5e879db4eac51c6698a69304000000000000000000000000" +
  "b5f762798a53d543a014caf8b297cff8f2f937e8000000000000000000000000" +
  "00000000000000000000000000000000000000000000000000000000000f4240" +
  "000000000000000000000000000000000000000000000000000000000000000c" +
  "000000000000000000000000000000000000000000000000000000000000002a" +
  "00000000000000000000000000000000000000000000000000000000000003e8" +
  "0000000000000000000000000000000000000000000000000000000080000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000160" +
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" +
  "0000000000000000000000000000000000000000000000000000000000000021" +
  "0388935426e0d08083314842edfbb2d517bd47699f9a4527318a8e10468c97c0" +
  "5200000000000000000000000000000000000000000000000000000000000000"

describe("xrp-vm encodeWithdrawal / decodeWithdrawal round-trip", () => {
  for (const v of vectors) {
    it(`${v.label} round-trips`, () => {
      const original: DecodedXrpVmWithdrawal = {
        vmType: "xrp-vm",
        withdrawal: v.decoded,
      }
      const encoded = encodeWithdrawal(original)
      const roundTripped = decodeWithdrawal(encoded, "xrp-vm")
      expect(roundTripped).toEqual(original)
    })
  }

  it("omits destinationTag on decode when none was set", () => {
    const decoded = decodeWithdrawal(
      encodeWithdrawal({ vmType: "xrp-vm", withdrawal: vectors[0].decoded }),
      "xrp-vm"
    )
    expect(decoded.vmType).toBe("xrp-vm")
    if (decoded.vmType === "xrp-vm") {
      expect(decoded.withdrawal.destinationTag).toBeUndefined()
      expect(decoded.withdrawal.account).toBe(ACCOUNT)
      expect(decoded.withdrawal.destination).toBe(DESTINATION)
    }
  })

  it("preserves a destinationTag of 0 through the round-trip", () => {
    const decoded = decodeWithdrawal(
      encodeWithdrawal({ vmType: "xrp-vm", withdrawal: vectors[1].decoded }),
      "xrp-vm"
    )
    if (decoded.vmType === "xrp-vm") {
      expect(decoded.withdrawal.destinationTag).toBe(0)
    }
  })
})

describe("xrp-vm payload layouts", () => {
  it("decodes a pre-InvoiceID payload and keeps its signing hash", () => {
    const decoded = decodeWithdrawal(LEGACY_V1_PAYLOAD, "xrp-vm")
    expect(decoded).toEqual({
      vmType: "xrp-vm",
      withdrawal: vectors[0].decoded,
    })
    expect(getDecodedWithdrawalId(decoded)).toBe(vectors[0].expectedHash)
    expect(encodeWithdrawal(decoded)).toBe(LEGACY_V1_PAYLOAD)
  })

  it("decodes a payload carrying an InvoiceID", () => {
    const decoded = decodeWithdrawal(V4_PAYLOAD, "xrp-vm")
    expect(decoded).toEqual({
      vmType: "xrp-vm",
      withdrawal: vectors[3].decoded,
    })
    expect(getDecodedWithdrawalId(decoded)).toBe(vectors[3].expectedHash)
    expect(encodeWithdrawal(decoded)).toBe(V4_PAYLOAD)
  })

  it("rejects bytes that match neither layout", () => {
    expect(() =>
      decodeWithdrawal(V4_PAYLOAD + "00".repeat(32), "xrp-vm")
    ).toThrow(/failed to decode xrp-vm/i)
  })
})

describe("xrp-vm getDecodedWithdrawalId matches the XRPL signing hash", () => {
  for (const v of vectors) {
    it(`${v.label} signing hash matches reference`, () => {
      const id = getDecodedWithdrawalId({
        vmType: "xrp-vm",
        withdrawal: v.decoded,
      })
      expect(id).toBe(v.expectedHash)
    })
  }

  it("changes when a destination tag is present versus absent", () => {
    const withoutTag = getDecodedWithdrawalId({
      vmType: "xrp-vm",
      withdrawal: vectors[1].decoded,
    })
    const noTagVariant = { ...vectors[1].decoded }
    delete (noTagVariant as { destinationTag?: number }).destinationTag
    const absent = getDecodedWithdrawalId({
      vmType: "xrp-vm",
      withdrawal: noTagVariant,
    })
    expect(withoutTag).not.toBe(absent)
  })

  it("changes with the InvoiceID", () => {
    const other = getDecodedWithdrawalId({
      vmType: "xrp-vm",
      withdrawal: { ...vectors[3].decoded, invoiceId: "0x" + "11".repeat(32) },
    })
    expect(other).not.toBe(vectors[3].expectedHash)
  })
})

describe("xrp-vm decoded-withdrawal helpers", () => {
  const decoded: DecodedXrpVmWithdrawal = {
    vmType: "xrp-vm",
    withdrawal: vectors[0].decoded,
  }

  it("getCurrency returns the native XRP sentinel", () => {
    expect(codec.getCurrency(decoded.withdrawal)).toBe(
      getVmTypeNativeCurrency("xrp-vm")
    )
  })

  it("getAmount returns the raw drops amount", () => {
    expect(codec.getAmount(decoded.withdrawal)).toBe("1000000")
  })

  it("getRecipient returns the destination address", () => {
    expect(codec.getRecipient(decoded.withdrawal)).toBe(DESTINATION)
  })
})

describe("xrp-vm issued-currency guard (native only in v1)", () => {
  const issued: DecodedXrpVmWithdrawal = {
    vmType: "xrp-vm",
    withdrawal: {
      ...vectors[0].decoded,
      currency: "USD",
      issuer: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    },
  }

  it("encodeWithdrawal rejects an issued currency", () => {
    expect(() => encodeWithdrawal(issued)).toThrow(/not yet supported/i)
  })

  it("getDecodedWithdrawalId rejects an issued currency", () => {
    expect(() => getDecodedWithdrawalId(issued)).toThrow(/not yet supported/i)
  })

  it("rejects a currency without an issuer", () => {
    const partial: DecodedXrpVmWithdrawal = {
      vmType: "xrp-vm",
      withdrawal: { ...vectors[0].decoded, currency: "USD" },
    }
    expect(() => encodeWithdrawal(partial)).toThrow(
      /require both currency and issuer/i
    )
  })
})
