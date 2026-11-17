import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, bech32m } from "@scure/base";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Order } from "../../src/common/relay-sdk.js";
import type { BitcoinVmTransaction, DepositAddressTrigger } from "../../src/common/types.js";
import {
  derivationFieldsToIndexes,
  deriveWallet,
  signTransactionsWithWallet,
  verifyTransactionsWithWallet,
} from "../../src/derivation/index.js";
import { BitcoinVmWalletDeriver } from "../../src/derivation/vm/bitcoin/BitcoinVmWalletDeriver.js";
import { runVmAction, type ActionParams, type SignResult } from "../../src/vm/action.js";
import { ROOT_KEY, hexToBytes } from "../transactions/shared.js";
import { makeAttestation, makeTrigger, ORDER_ID } from "./shared.js";

// The request and attestation checks have their own tests; stub them so runVmAction reaches signing.
vi.mock("../../src/attestation/index.js", () => ({
  recoverPersonalSignAddress: () => "0x000000000000000000000000000000000000cafe",
  verifyDepositAddressTriggerAttestation: async () => {},
  verifyOrderData: () => {},
}));

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
      changeScripts?: string[];
      changeValue?: bigint;
      metadata?: string[];
      signerProgram?: string;
    } = {},
  ): BitcoinVmTransaction {
    const amount = opts.amount ?? BITCOIN_AMOUNT;
    const orderId = opts.orderId ?? ORDER_ID;
    const depositor = opts.depositor ?? BITCOIN_DEPOSITOR;
    const metadata = (opts.metadata ?? [`${orderId}|depositor=${depositor}|`]).map((value) =>
      Buffer.from(value, "utf8").toString("hex"),
    );
    const isSegwit = opts.witness !== undefined;
    const sats = (value: bigint) =>
      value.toString(16).padStart(16, "0").match(/../gu)!.reverse().join("");
    const outputs = [
      sats(amount),
      `${(BITCOIN_DEPOSITORY_SCRIPT.length / 2).toString(16).padStart(2, "0")}${BITCOIN_DEPOSITORY_SCRIPT}`,
      ...(opts.changeScripts ?? []).flatMap((changeScript) => [
        sats(opts.changeValue ?? 1_000n),
        `${(changeScript.length / 2).toString(16).padStart(2, "0")}${changeScript}`,
      ]),
      ...metadata.flatMap((value) => [
        "0000000000000000",
        `${(3 + value.length / 2).toString(16).padStart(2, "0")}6a4c${(value.length / 2).toString(16).padStart(2, "0")}${value}`,
      ]),
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
    const sighash = opts.signerProgram
      ? bip143Sighash(outputs.join(""), opts.signerProgram)
      : `0x${"00".repeat(32)}`;
    return { unsignedTransaction, inputValues: ["60000"], sighashes: [sighash] };
  }

  // BIP143 SIGHASH_ALL digest of buildBitcoinTx's single input, spent by the P2WPKH `program`.
  function bip143Sighash(outputsHex: string, program: string): string {
    const hash256 = (hex: string) =>
      Buffer.from(sha256(sha256(Buffer.from(hex, "hex")))).toString("hex");
    const outpoint = `${"22".repeat(32)}00000000`;
    const preimage = [
      "01000000", // version
      hash256(outpoint),
      hash256("fdffffff"),
      outpoint,
      `1976a914${program}88ac`, // P2WPKH script code
      "60ea000000000000", // input value: 60_000 sats
      "fdffffff",
      hash256(outputsHex),
      "00000000", // locktime
      "01000000", // SIGHASH_ALL
    ].join("");
    return `0x${hash256(preimage)}`;
  }

  // The deposit wallet the action derives from the trigger's derivation fields.
  async function depositWallet(trigger: DepositAddressTrigger) {
    const indexes = derivationFieldsToIndexes(trigger.derivationFields);
    const wallet = await deriveWallet(ROOT_KEY, "bitcoin-vm", indexes);
    const { words } = bech32.decode(wallet.address as `bc1${string}`);
    const program = Buffer.from(bech32.fromWords(words.slice(1))).toString("hex");
    return { wallet, program };
  }

  // Same path as the action: the policy sees the derived wallet before anything is signed.
  async function verifyAndSign(trigger: DepositAddressTrigger, tx: BitcoinVmTransaction) {
    const indexes = derivationFieldsToIndexes(trigger.derivationFields);
    return signTransactionsWithWallet(ROOT_KEY, "bitcoin-vm", indexes, [tx], (wallet) =>
      verifyTransactionsWithWallet(trigger, bitcoinAttestation(), [tx], wallet),
    );
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
        buildBitcoinTx({ changeScripts: [BITCOIN_REFUND_SCRIPT] }),
      ]),
    ).not.toThrow();
  });

  it("rejects a native BTC deposit with change to an unexpected script", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ changeScripts: [`0014${"44".repeat(20)}`] }),
      ]),
    ).toThrow(/non-depository, non-OP_RETURN outputs must pay/);
  });

  it("signs a deposit with change back to the deposit address", async () => {
    const trigger = bitcoinTrigger();
    const { wallet, program } = await depositWallet(trigger);
    const tx = buildBitcoinTx({ changeScripts: [`0014${program}`], signerProgram: program });
    const { signedTransactions } = await verifyAndSign(trigger, tx);
    expect(
      secp256k1.verify(
        hexToBytes(signedTransactions[0].signatures[0]),
        hexToBytes(tx.sighashes[0]),
        hexToBytes(wallet.publicKey),
        { prehash: false },
      ),
    ).toBe(true);
  });

  it("rejects change to another deposit address", async () => {
    const trigger = bitcoinTrigger();
    const other = bitcoinTrigger();
    other.derivationFields.salt = "124";
    const { program } = await depositWallet(trigger);
    const { program: otherProgram } = await depositWallet(other);
    await expect(
      verifyAndSign(
        trigger,
        buildBitcoinTx({ changeScripts: [`0014${otherProgram}`], signerProgram: program }),
      ),
    ).rejects.toThrow(/must pay trigger\.derivationFields\.refundRecipient or the deposit wallet/);
  });

  it("signs a deposit with change to both refundRecipient and the deposit address", async () => {
    const trigger = bitcoinTrigger();
    const { program } = await depositWallet(trigger);
    const tx = buildBitcoinTx({
      changeScripts: [BITCOIN_REFUND_SCRIPT, `0014${program}`],
      signerProgram: program,
    });
    const { signedTransactions } = await verifyAndSign(trigger, tx);
    expect(signedTransactions[0].signatures).toHaveLength(1);
  });

  it("rejects a depository amount other than input.amount even with change to the deposit address", async () => {
    const trigger = bitcoinTrigger();
    const { program } = await depositWallet(trigger);
    await expect(
      verifyAndSign(
        trigger,
        buildBitcoinTx({
          amount: BITCOIN_AMOUNT - 1n,
          changeScripts: [`0014${program}`],
          signerProgram: program,
        }),
      ),
    ).rejects.toThrow(/value sent to input depository must equal input\.amount/);
  });

  it("rejects change to the deposit wallet below 546 sats", async () => {
    const trigger = bitcoinTrigger();
    const { program } = await depositWallet(trigger);
    const build = (changeValue: bigint) =>
      buildBitcoinTx({ changeScripts: [`0014${program}`], changeValue, signerProgram: program });
    await expect(verifyAndSign(trigger, build(545n))).rejects.toThrow(
      /change to the deposit wallet must be at least 546 sats, got=545/,
    );
    const { signedTransactions } = await verifyAndSign(trigger, build(546n));
    expect(signedTransactions[0].signatures).toHaveLength(1);
  });

  it("lets a refund sweep spend the change left at the deposit wallet", async () => {
    // A refund order gets its own trigger for the same derivation fields, so the same deposit wallet.
    const refundTrigger = bitcoinTrigger({ amount: 9_000n });
    refundTrigger.orderId = `0x${"ee".repeat(32)}`;
    const { program } = await depositWallet(refundTrigger);
    const tx = buildBitcoinTx({
      amount: 9_000n,
      orderId: refundTrigger.orderId,
      signerProgram: program,
    });
    const { signedTransactions } = await verifyAndSign(refundTrigger, tx);
    expect(signedTransactions[0].signatures).toHaveLength(1);
  });

  describe("through runVmAction", () => {
    beforeAll(() => {
      Object.assign(globalThis, { Lit: { Actions: { getPrivateKey: async () => ROOT_KEY } } });
    });

    function signParams(
      trigger: DepositAddressTrigger,
      tx: BitcoinVmTransaction,
    ): ActionParams<"bitcoin-vm"> {
      return {
        pkpId: "0x1",
        action: "sign",
        trigger,
        attestation: bitcoinAttestation(),
        order: { solver: "0x000000000000000000000000000000000000cafe" } as Order,
        orderSignature: "0x",
        requestSignature: "0x",
        transactions: [tx],
      };
    }

    it("signs change back to the deposit wallet it derives", async () => {
      const trigger = bitcoinTrigger();
      const { wallet, program } = await depositWallet(trigger);
      const tx = buildBitcoinTx({ changeScripts: [`0014${program}`], signerProgram: program });
      const result = (await runVmAction(
        "bitcoin-vm",
        new BitcoinVmWalletDeriver(),
        signParams(trigger, tx),
      )) as SignResult<"bitcoin-vm">;
      expect(result.wallet.address).toBe(wallet.address);
      expect(result.signedTransactions[0].signatures).toHaveLength(1);
    });

    it("runs the transaction policy before signing", async () => {
      const trigger = bitcoinTrigger();
      const { program } = await depositWallet(trigger);
      const deriver = new BitcoinVmWalletDeriver();
      const sign = vi.spyOn(
        deriver as unknown as { signTransactionWithKey: () => unknown },
        "signTransactionWithKey",
      );
      const tx = buildBitcoinTx({ amount: BITCOIN_AMOUNT - 1n, signerProgram: program });
      await expect(runVmAction("bitcoin-vm", deriver, signParams(trigger, tx))).rejects.toThrow(
        /value sent to input depository must equal input\.amount/,
      );
      expect(sign).not.toHaveBeenCalled();
    });
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

  it("accepts a Taproot depositor", () => {
    const depositor = bech32m.encode("bc", [1, ...bech32m.toWords(new Uint8Array(32).fill(17))]);
    expect(() =>
      verifyTransactionsWithWallet(
        bitcoinTrigger({ depositor: `0x01${"11".repeat(32)}` }),
        bitcoinAttestation(),
        [buildBitcoinTx({ depositor })],
      ),
    ).not.toThrow();
  });

  it("rejects a non-lowercase bech32 depositor", () => {
    const depositor = bech32m.encode("bc", [1, ...bech32m.toWords(new Uint8Array(32).fill(17))]);
    expect(() =>
      verifyTransactionsWithWallet(
        bitcoinTrigger({ depositor: `0x01${"11".repeat(32)}` }),
        bitcoinAttestation(),
        [buildBitcoinTx({ depositor: depositor.toUpperCase() })],
      ),
    ).toThrow(/unsupported bitcoin address format/);
  });

  it.each([true, false])(
    "selects the first order id and depositor across OP_RETURN outputs (foreign first: %s)",
    (foreignFirst) => {
      const legitimate = `${ORDER_ID}|depositor=${BITCOIN_DEPOSITOR}|`;
      const foreign = `0x${"cd".repeat(32)}|depositor=1BoatSLRHtKNngkdXEeobR76b53LETtpyT|`;
      const run = () =>
        verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
          buildBitcoinTx({
            metadata: foreignFirst ? [foreign, legitimate] : [legitimate, foreign],
          }),
        ]);
      if (foreignFirst) {
        expect(run).toThrow(/must start with trigger\.orderId/);
      } else {
        expect(run).not.toThrow();
      }
    },
  );

  it("rejects a deposit whose explicit OP_RETURN depositor differs from derivation fields", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ depositor: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" }),
      ]),
    ).toThrow(/OP_RETURN depositor mismatch/);
  });
});
