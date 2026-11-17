import { Address as TonAddress, crc16 } from "@ton/core";
import { describe, expect, it } from "vitest";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  TonVmTransaction,
} from "../../src/common/types.js";
import { verifyTransactionsWithWallet } from "../../src/derivation/index.js";
import { makeAttestation, makeTrigger, ORDER_ID } from "./shared.js";

const TON_NATIVE = `0x${"00".repeat(32)}`;
const TON_DEPOSITORY = `0x${"22".repeat(32)}`;
const TON_DEPOSITOR = `0x${"33".repeat(32)}`;
const TON_DEPOSITORY_ADDR = `0:${"22".repeat(32)}`;
const TON_DEPOSITOR_ADDR = `0:${"33".repeat(32)}`;
const TON_AMOUNT = "1500000000";

describe("ton-vm transaction policy", () => {
  function makeTonTrigger(): DepositAddressTrigger {
    const trigger = makeTrigger({ inputVmType: "ton-vm", inputCurrency: TON_NATIVE });
    trigger.input.chainId = "ton-mainnet";
    trigger.input.amount = TON_AMOUNT;
    trigger.derivationFields.depositor = TON_DEPOSITOR;
    return trigger;
  }

  function makeTonAttestation(): DepositAddressTriggerAttestation {
    return { ...makeAttestation(), inputDepository: TON_DEPOSITORY };
  }

  function buildTonTx(overrides: Partial<TonVmTransaction> = {}): TonVmTransaction {
    return {
      to: TON_DEPOSITORY_ADDR,
      amount: TON_AMOUNT,
      comment: `${ORDER_ID}|depositor=${TON_DEPOSITOR_ADDR}|`,
      bounce: false,
      seqno: 0,
      validUntil: 2_000_000_000,
      sendMode: 3,
      ...overrides,
    };
  }

  it("accepts a well-formed native TON deposit sweep", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [buildTonTx()]),
    ).not.toThrow();
  });

  it("accepts a friendly-form depositor in the comment", () => {
    const friendly = new TonAddress(0, Buffer.from("33".repeat(32), "hex")).toString({
      urlSafe: true,
      bounceable: true,
    });
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ comment: `${ORDER_ID}|depositor=${friendly}|` }),
      ]),
    ).not.toThrow();
  });

  it("accepts a padded depositor tag and an uppercase order id", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({
          comment: `0x${ORDER_ID.slice(2).toUpperCase()}|depositor= ${TON_DEPOSITOR_ADDR} |`,
        }),
      ]),
    ).not.toThrow();
  });

  it("rejects a comment that does not start with an order id", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ comment: `relay${ORDER_ID}|depositor=${TON_DEPOSITOR_ADDR}|` }),
      ]),
    ).toThrow(/must start with a 32-byte order id/);
  });

  it("uses the first depositor tag only", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({
          comment: `${ORDER_ID}|depositor=0:${"66".repeat(32)}|depositor=${TON_DEPOSITOR_ADDR}|`,
        }),
      ]),
    ).toThrow(/comment depositor mismatch/);
  });

  it("rejects a friendly depositor with a valid checksum but unknown tag byte", () => {
    const payload = Buffer.concat([Buffer.from([0x12, 0]), Buffer.from("33".repeat(32), "hex")]);
    const depositor = Buffer.concat([payload, crc16(payload)]).toString("base64url");
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ comment: `${ORDER_ID}|depositor=${depositor}|` }),
      ]),
    ).toThrow(/invalid TON address tag/);
  });

  it.each([
    ["an inserted character", (s: string) => `${s.slice(0, 10)}!${s.slice(10)}`],
    ["a trailing character", (s: string) => `${s}A`],
  ])("rejects a friendly depositor with %s", (_caseName, mutate) => {
    const friendly = new TonAddress(0, Buffer.from("33".repeat(32), "hex")).toString({
      urlSafe: true,
      bounceable: true,
    });
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ comment: `${ORDER_ID}|depositor=${mutate(friendly)}|` }),
      ]),
    ).toThrow(/invalid TON address/);
  });

  it("rejects more than one transaction", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx(),
        buildTonTx(),
      ]),
    ).toThrow(/exactly 1 transaction/);
  });

  it("rejects non-native currency", () => {
    const trigger = makeTonTrigger();
    trigger.input.currency = `0x${"44".repeat(32)}`;
    expect(() =>
      verifyTransactionsWithWallet(trigger, makeTonAttestation(), [buildTonTx()]),
    ).toThrow(/only supports native TON/);
  });

  it("rejects a bounceable transfer", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ bounce: true }),
      ]),
    ).toThrow(/non-bounceable/);
  });

  it("rejects a transfer to the wrong destination", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ to: `0:${"55".repeat(32)}` }),
      ]),
    ).toThrow(/must equal input depository/);
  });

  it("rejects an amount that doesn't match input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ amount: "1" }),
      ]),
    ).toThrow(/amount must equal input\.amount/);
  });

  it("rejects a carry-all send mode", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ sendMode: 128 }),
      ]),
    ).toThrow(/carry the remaining balance/);
  });

  it("rejects a comment without the trigger order id", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ comment: `0x${"cd".repeat(32)}|depositor=${TON_DEPOSITOR_ADDR}|` }),
      ]),
    ).toThrow(/must start with trigger\.orderId/);
  });

  it("rejects a comment without depositor metadata", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ comment: ORDER_ID }),
      ]),
    ).toThrow(/must include \|depositor=/);
  });

  it("rejects a depositor that doesn't match the trigger", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTonTrigger(), makeTonAttestation(), [
        buildTonTx({ comment: `${ORDER_ID}|depositor=0:${"66".repeat(32)}|` }),
      ]),
    ).toThrow(/depositor mismatch/);
  });
});
