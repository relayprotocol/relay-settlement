// ABOUTME: Round-trip tests for ton-vm withdrawal encode/decode + cell-hash withdrawalId.
// ABOUTME: Reference hashes mirror smart-contracts TonVmPayloadBuilder.t.sol — drift = SDK out of sync with on-chain hashesToSign.

import { describe, it, expect } from "vitest"

import {
  decodeWithdrawal,
  DecodedTonVmWithdrawal,
  encodeWithdrawal,
  getDecodedWithdrawalAmount,
  getDecodedWithdrawalCurrency,
  getDecodedWithdrawalId,
  getDecodedWithdrawalRecipient,
} from "../src/messages/v2.1/depository-withdrawal"
import { getVmTypeNativeCurrency } from "../src/utils"

// Reference vectors mirror smart-contracts/tools/tonReferenceHashes.ts and the
// foundry test smart-contracts/test/PayloadBuilders/TonVmPayloadBuilder.t.sol.
// The expected msg_inner cell hashes are taken verbatim from that foundry test,
// so a mismatch here means the SDK has drifted from the on-chain builder.
const RECEIVER_RAW =
  "0:1122334455667788990011223344556677889900112233445566778899001122"
const ZERO_RECEIVER_RAW =
  "0:0000000000000000000000000000000000000000000000000000000000000000"

// SUBWALLET_ID + TIMEOUT match the canonical reference deployment used by
// tools/tonReferenceHashes.ts. Cell hashes below are independent of where these
// values come from (immutable vs. payload) — bit layout is unchanged.
const SUBWALLET_ID = 0x10ad0001
const TIMEOUT = 3600

const vectors = [
  {
    label: "V1 zero fields",
    decoded: {
      receiver: ZERO_RECEIVER_RAW,
      amount: "0",
      createdAt: 1700000000,
      queryId: 0,
      subwalletId: SUBWALLET_ID,
      timeout: TIMEOUT,
    },
    expectedHash:
      "0xbcec9dc4ba69d5cd50b1d6d5a2f9639aec212c3eca5d1ee4185aa5eee6739dd5",
  },
  {
    label: "V2 typical native TON transfer",
    decoded: {
      receiver: RECEIVER_RAW,
      amount: "100000000",
      createdAt: 1735680000,
      queryId: 42,
      subwalletId: SUBWALLET_ID,
      timeout: TIMEOUT,
    },
    expectedHash:
      "0xdcb6f3ef5082435f374ab7c2ec0e5d7215321006fd2dbc9be2b32bbc28aea525",
  },
  {
    label: "V3 amount at VarUInteger16 boundary, max valid queryId",
    decoded: {
      receiver: RECEIVER_RAW,
      amount: ((1n << 120n) - 1n).toString(),
      createdAt: 2000000000,
      queryId: (1 << 23) - 2,
      subwalletId: SUBWALLET_ID,
      timeout: TIMEOUT,
    },
    expectedHash:
      "0x4fafc2989c0759db4e851e3d25603f5c982d01bc2831c507c687aec1c34d0507",
  },
]

describe("ton-vm encodeWithdrawal / decodeWithdrawal round-trip", () => {
  for (const v of vectors) {
    it(`${v.label} round-trips`, () => {
      const original: DecodedTonVmWithdrawal = {
        vmType: "ton-vm",
        withdrawal: v.decoded,
      }
      const encoded = encodeWithdrawal(original)
      const roundTripped = decodeWithdrawal(encoded, "ton-vm")
      expect(roundTripped).toEqual(original)
    })
  }

  it("decoded receiver is canonical TON raw form (0:<hex>)", () => {
    const decoded = decodeWithdrawal(
      encodeWithdrawal({ vmType: "ton-vm", withdrawal: vectors[1].decoded }),
      "ton-vm"
    )
    expect(decoded.vmType).toBe("ton-vm")
    if (decoded.vmType === "ton-vm") {
      expect(decoded.withdrawal.receiver).toMatch(/^0:[0-9a-f]{64}$/)
      expect(decoded.withdrawal.receiver).toBe(RECEIVER_RAW)
    }
  })
})

describe("ton-vm getDecodedWithdrawalId matches on-chain hashesToSign", () => {
  for (const v of vectors) {
    it(`${v.label} cell hash matches contract reference`, () => {
      const id = getDecodedWithdrawalId({
        vmType: "ton-vm",
        withdrawal: v.decoded,
      })
      expect(id).toBe(v.expectedHash)
    })
  }
})

describe("ton-vm decoded-withdrawal helpers", () => {
  const decoded: DecodedTonVmWithdrawal = {
    vmType: "ton-vm",
    withdrawal: vectors[1].decoded,
  }

  it("getDecodedWithdrawalCurrency returns the native TON sentinel", () => {
    expect(getDecodedWithdrawalCurrency(decoded)).toBe(
      getVmTypeNativeCurrency("ton-vm")
    )
  })

  it("getDecodedWithdrawalAmount returns the raw nanoton amount", () => {
    expect(getDecodedWithdrawalAmount(decoded)).toBe("100000000")
  })

  it("getDecodedWithdrawalRecipient returns the canonical receiver", () => {
    expect(getDecodedWithdrawalRecipient(decoded)).toBe(RECEIVER_RAW)
  })
})
