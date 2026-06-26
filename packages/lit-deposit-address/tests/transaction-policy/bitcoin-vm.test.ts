import { describe, expect, it } from "vitest";
import type { BitcoinVmTransaction } from "../../src/common/types.js";
import { verifyTransactionsWithWallet } from "../../src/derivation/index.js";
import { makeAttestation, makeTrigger, ORDER_ID } from "./shared.js";

describe("bitcoin-vm transaction policy", () => {
  const BITCOIN_NATIVE_CURRENCY = `0x${"00".repeat(20)}`;
  const BITCOIN_DEPOSITORY_ENCODED = `0x00${"11".repeat(20)}`;
  const BITCOIN_DEPOSITORY_SCRIPT = `0014${"11".repeat(20)}`;
  const BITCOIN_REFUND_ENCODED = `0x00${"33".repeat(20)}`;
  const BITCOIN_REFUND_SCRIPT = `0014${"33".repeat(20)}`;
  const BITCOIN_DEPOSITOR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
  const BITCOIN_DEPOSITOR_ENCODED = "0xff0062e907b15cbf27d5425399ebf6f0fb50ebb88f18";
  const BITCOIN_AMOUNT = 50_000n;

  function bitcoinTrigger(overrides: { amount?: bigint; depositor?: string } = {}) {
    const trigger = makeTrigger({
      inputVmType: "bitcoin-vm",
      inputCurrency: BITCOIN_NATIVE_CURRENCY,
    });
    trigger.input.amount = (overrides.amount ?? BITCOIN_AMOUNT).toString();
    trigger.derivationFields.depositor = overrides.depositor ?? BITCOIN_DEPOSITOR_ENCODED;
    trigger.derivationFields.refundRecipient = BITCOIN_REFUND_ENCODED;
    return trigger;
  }

  function bitcoinAttestation() {
    return { ...makeAttestation(), inputDepository: BITCOIN_DEPOSITORY_ENCODED };
  }

  function buildBitcoinTx(
    opts: {
      amount?: bigint;
      orderId?: string;
      depositor?: string;
      witness?: string;
      changeScript?: string;
    } = {},
  ): BitcoinVmTransaction {
    const amount = opts.amount ?? BITCOIN_AMOUNT;
    const orderId = opts.orderId ?? ORDER_ID;
    const depositor = opts.depositor ?? BITCOIN_DEPOSITOR;
    const metadata = Buffer.from(`${orderId}|depositor=${depositor}|`, "utf8").toString("hex");
    const isSegwit = opts.witness !== undefined;
    const changeScript = opts.changeScript;
    const outputs = [
      amount.toString(16).padStart(16, "0").match(/../gu)!.reverse().join(""),
      `${(BITCOIN_DEPOSITORY_SCRIPT.length / 2).toString(16).padStart(2, "0")}${BITCOIN_DEPOSITORY_SCRIPT}`,
      ...(changeScript
        ? [
            "0100000000000000",
            `${(changeScript.length / 2).toString(16).padStart(2, "0")}${changeScript}`,
          ]
        : []),
      "0000000000000000",
      `${(1 + 2 + metadata.length / 2).toString(16).padStart(2, "0")}6a4c${(metadata.length / 2)
        .toString(16)
        .padStart(2, "0")}${metadata}`,
    ];
    const unsignedTransaction =
      "0x" +
      [
        "01000000", // version
        isSegwit ? "0001" : "", // segwit marker + flag
        "01", // input count
        "22".repeat(32), // previous txid (little-endian bytes)
        "00000000", // previous output index
        "00", // empty scriptSig
        "fdffffff", // sequence
        (outputs.length / 2).toString(16).padStart(2, "0"), // output count
        ...outputs,
        opts.witness ?? "", // one witness stack per input when segwit marker is present
        "00000000", // locktime
      ].join("");
    return { unsignedTransaction, inputValues: ["60000"], sighashes: [`0x${"00".repeat(32)}`] };
  }

  it("accepts a native BTC deposit with orderId and explicit depositor metadata", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [buildBitcoinTx()]),
    ).not.toThrow();
  });

  it("accepts a segwit-flagged unsigned BTC deposit with an empty witness", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ witness: "00" }),
      ]),
    ).not.toThrow();
  });

  it("rejects a segwit-flagged unsigned BTC deposit with a non-empty witness", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ witness: "010100" }),
      ]),
    ).toThrow(/witness\[0\] must be empty/);
  });

  it("accepts a native BTC deposit with change to refundRecipient", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ changeScript: BITCOIN_REFUND_SCRIPT }),
      ]),
    ).not.toThrow();
  });

  it("rejects a native BTC deposit with change to an unexpected script", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ changeScript: `0014${"44".repeat(20)}` }),
      ]),
    ).toThrow(/non-depository, non-OP_RETURN outputs must pay/);
  });

  it("rejects a deposit whose depository output amount does not match input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ amount: BITCOIN_AMOUNT - 1n }),
      ]),
    ).toThrow(/value sent to input depository must equal input\.amount/);
  });

  it("rejects a deposit without the trigger order id in OP_RETURN", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ orderId: `0x${"cd".repeat(32)}` }),
      ]),
    ).toThrow(/OP_RETURN metadata must start with trigger\.orderId/);
  });

  it("rejects a deposit whose explicit OP_RETURN depositor differs from derivation fields", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ depositor: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" }),
      ]),
    ).toThrow(/OP_RETURN depositor mismatch/);
  });
});
