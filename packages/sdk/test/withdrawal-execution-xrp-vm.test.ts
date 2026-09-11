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
]

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
