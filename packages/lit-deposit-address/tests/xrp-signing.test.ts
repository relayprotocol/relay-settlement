import { encodeAbiParameters } from "viem";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { decode, encode, encodeForSigning } from "ripple-binary-codec";
import { verify } from "ripple-keypairs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAddressFromHex, encodeAddressToHex } from "../src/common/address.js";
import {
  signTransactionsWithWallet,
  verifyTransactionsWithWallet,
} from "../src/derivation/index.js";
import { DEPOSITOR, makeAttestation, makeTrigger, ORDER_ID } from "./transaction-policy/shared.js";
import fixture from "./xrp-derivation.fixture.json" with { type: "json" };

const NOW = 1_800_000_000n;
beforeAll(() => {
  vi.spyOn(Date, "now").mockReturnValue(Number(NOW) * 1000);
});
beforeEach(() => vi.mocked(Date.now).mockReturnValue(Number(NOW) * 1000));
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const wallet = { ...fixture.wallet, vmType: "xrp-vm" as const };
const depository = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const memo = Buffer.from(`${ORDER_ID}|depositor=${decodeAddressFromHex(DEPOSITOR, "xrp-vm")}|`)
  .toString("hex")
  .toUpperCase();
const payment = {
  TransactionType: "Payment",
  Account: fixture.wallet.address,
  Destination: depository,
  Amount: "1000000",
  Fee: "12",
  Sequence: 1,
  LastLedgerSequence: 100,
  Flags: 0x80000000,
  SigningPubKey: "",
  Memos: [{ Memo: { MemoData: memo } }],
};
const trigger = makeTrigger({ inputVmType: "xrp-vm" });
trigger.input.chainId = "xrp";
trigger.extraData = encodeAbiParameters([{ type: "uint32" }, { type: "uint64" }], [96, NOW]);
trigger.input.amount = payment.Amount;
const attestation = makeAttestation();
attestation.inputDepository = encodeAddressToHex(depository, "xrp-vm");

/** Serialize a Payment with selected fields replaced for a policy check. */
function transaction(overrides: Record<string, unknown> = {}) {
  return { unsignedTransaction: encode({ ...payment, ...overrides }) };
}

/** Check the XRP policy against the fixed derived wallet. */
function authorize(overrides: Record<string, unknown> = {}): void {
  verifyTransactionsWithWallet(trigger, attestation, [transaction(overrides)], wallet);
}

describe("XRP native sweep signing", () => {
  it("signs a canonical Payment with the derived wallet and returns its XRPL transaction id", async () => {
    const unsigned = transaction();
    const {
      wallet,
      signedTransactions: [signed],
    } = await signTransactionsWithWallet(
      fixture.rootKeyHex,
      "xrp-vm",
      fixture.wallet.indexes,
      [unsigned],
      (wallet) => verifyTransactionsWithWallet(trigger, attestation, [unsigned], wallet),
    );
    const decoded = decode(signed.rawTransaction);
    const publicKey = fixture.wallet.publicKey.slice(2).toUpperCase();
    expect(wallet).toEqual(fixture.wallet);
    expect(decoded).toEqual({
      ...payment,
      SigningPubKey: publicKey,
      TxnSignature: decoded.TxnSignature,
    });
    expect(verify(encodeForSigning(decoded), decoded.TxnSignature as string, publicKey)).toBe(true);
    const digest = createHash("sha512")
      .update(Buffer.from(encodeForSigning(decoded), "hex"))
      .digest()
      .subarray(0, 32);
    const signature = secp256k1.Signature.fromBytes(
      Buffer.from(decoded.TxnSignature as string, "hex"),
      "der",
    );
    expect(signature.hasHighS()).toBe(false);
    expect(
      secp256k1.verify(signature.toBytes("der"), digest, Buffer.from(publicKey, "hex"), {
        prehash: false,
        format: "der",
      }),
    ).toBe(true);
    expect(signed.transactionHash).toBe(
      createHash("sha512")
        .update(Buffer.from(`54584E00${signed.rawTransaction}`, "hex"))
        .digest("hex")
        .slice(0, 64)
        .toUpperCase(),
    );
  });

  it("binds direct signing to the actual private key without an authorization callback", async () => {
    await expect(
      signTransactionsWithWallet(fixture.rootKeyHex, "xrp-vm", fixture.wallet.indexes, [
        transaction({ Account: depository }),
      ]),
    ).rejects.toThrow("XRP transaction Account mismatch");
  });
});

describe("XRP native sweep policy", () => {
  it("accepts one exact native sweep", () => {
    expect(() => authorize()).not.toThrow();
  });

  it("accepts absent or zero flags and the fee cap", () => {
    expect(() => authorize({ Flags: undefined, Fee: "10000" })).not.toThrow();
    expect(() => authorize({ Flags: 0 })).not.toThrow();
  });

  it.each([
    ["sender", { Account: depository }],
    ["recipient", { Destination: fixture.wallet.address }],
    ["amount", { Amount: "999999" }],
    ["zero amount", { Amount: "0" }],
    ["issued asset", { Amount: { currency: "USD", issuer: depository, value: "1" } }],
    ["excess fee", { Fee: "10001" }],
    ["zero fee", { Fee: "0" }],
    ["negative fee", { Fee: "-1" }],
    ["missing sequence", { Sequence: undefined }],
    ["ticket sequence", { Sequence: 0, TicketSequence: 7 }],
    ["missing expiry", { LastLedgerSequence: undefined }],
    ["zero expiry", { LastLedgerSequence: 0 }],
    ["partial payment", { Flags: 0x00020000 }],
    ["unknown flag", { Flags: 1 }],
    ["mainnet NetworkID", { NetworkID: 0 }],
    ["Relay row as NetworkID", { NetworkID: 537724 }],
    ["source tag", { SourceTag: 42 }],
    ["destination tag", { DestinationTag: 42 }],
    ["paths", { Paths: [[{ account: depository }]] }],
    ["send max", { SendMax: "1000001" }],
    ["deliver min", { DeliverMin: "1" }],
    ["invoice", { InvoiceID: "00".repeat(32) }],
    ["existing signing key", { SigningPubKey: fixture.wallet.publicKey.slice(2) }],
    ["existing signature", { TxnSignature: "3006020101020101" }],
    [
      "multisign",
      {
        Signers: [
          {
            Signer: {
              Account: depository,
              SigningPubKey: fixture.wallet.publicKey.slice(2),
              TxnSignature: "3006020101020101",
            },
          },
        ],
      },
    ],
    ["missing memo", { Memos: undefined }],
    ["binary order id", { Memos: [{ Memo: { MemoData: ORDER_ID.slice(2) } }] }],
    [
      "other order",
      { Memos: [{ Memo: { MemoData: Buffer.from(`0x${"cd".repeat(32)}`).toString("hex") } }] },
    ],
    ["extra memo", { Memos: [{ Memo: { MemoData: memo } }, { Memo: { MemoData: memo } }] }],
    ["memo metadata", { Memos: [{ Memo: { MemoData: memo, MemoType: "01" } }] }],
    ["different transaction type", { TransactionType: "AccountSet" }],
  ])("rejects %s", (_name, fields) => {
    expect(() => authorize(fields)).toThrow();
  });

  it("accepts expiry up to 32 ledgers past the attested reference", () => {
    expect(() => authorize({ LastLedgerSequence: 128 })).not.toThrow();
    expect(() => authorize({ LastLedgerSequence: 129 })).toThrow("XRP ledger expiry");
  });

  it("allows 10 seconds per ledger before the earliest price expiry", () => {
    const expiring = structuredClone(trigger);
    expiring.prices = [
      {
        usdPrice: "1",
        usdPriceDecimals: 0,
        currencyDecimals: 6,
        publishTime: String(NOW),
        expiration: String(NOW + 319n),
      },
    ];
    expect(() =>
      verifyTransactionsWithWallet(
        expiring,
        attestation,
        [transaction({ LastLedgerSequence: 127 })],
        wallet,
      ),
    ).not.toThrow();
    expect(() =>
      verifyTransactionsWithWallet(
        expiring,
        attestation,
        [transaction({ LastLedgerSequence: 128 })],
        wallet,
      ),
    ).toThrow("XRP ledger expiry");
  });

  it("reduces the ledger window when the attested prices expire sooner", () => {
    const expiring = structuredClone(trigger);
    expiring.prices = [
      {
        usdPrice: "1",
        usdPriceDecimals: 0,
        currencyDecimals: 6,
        publishTime: String(NOW),
        expiration: String(NOW + 19n),
      },
    ];
    expect(() =>
      verifyTransactionsWithWallet(expiring, attestation, [transaction()], wallet),
    ).toThrow("XRP ledger expiry");
  });

  it.each([NOW - 1n, NOW, NOW + 1n, NOW + 15n, NOW + 16n])(
    "keeps the attested ledger window stable at node time %s",
    (nodeTime) => {
      const expiring = structuredClone(trigger);
      expiring.prices = [
        {
          usdPrice: "1",
          usdPriceDecimals: 0,
          currencyDecimals: 6,
          publishTime: String(NOW),
          expiration: String(NOW + 40n),
        },
      ];
      vi.mocked(Date.now).withImplementation(
        () => Number(nodeTime) * 1000,
        () => {
          expect(() =>
            verifyTransactionsWithWallet(expiring, attestation, [transaction()], wallet),
          ).not.toThrow();
          expect(() =>
            verifyTransactionsWithWallet(
              expiring,
              attestation,
              [transaction({ LastLedgerSequence: 101 })],
              wallet,
            ),
          ).toThrow("XRP ledger expiry");
        },
      );
    },
  );

  it("rejects malformed depositor AccountID bytes", () => {
    const malformed = structuredClone(trigger);
    malformed.derivationFields.depositor = "0x01";
    expect(() =>
      verifyTransactionsWithWallet(malformed, attestation, [transaction()], wallet),
    ).toThrow();
  });

  it("rejects a token input", () => {
    const tokenTrigger = structuredClone(trigger);
    tokenTrigger.input.currency = encodeAddressToHex(depository, "xrp-vm");
    expect(() =>
      verifyTransactionsWithWallet(tokenTrigger, attestation, [transaction()], wallet),
    ).toThrow();
  });

  it("requires exactly one transaction and the derived wallet", () => {
    expect(() => verifyTransactionsWithWallet(trigger, attestation, [], wallet)).toThrow();
    expect(() =>
      verifyTransactionsWithWallet(trigger, attestation, [transaction(), transaction()], wallet),
    ).toThrow();
    expect(() => verifyTransactionsWithWallet(trigger, attestation, [transaction()])).toThrow();
  });

  it("rejects malformed or noncanonical bytes", () => {
    for (const unsignedTransaction of [
      "",
      "xyz",
      `${transaction().unsignedTransaction}00`,
      `0x${transaction().unsignedTransaction}`,
    ]) {
      expect(() =>
        verifyTransactionsWithWallet(trigger, attestation, [{ unsignedTransaction }], wallet),
      ).toThrow();
    }
  });
});
