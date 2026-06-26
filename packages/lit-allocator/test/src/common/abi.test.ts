import { describe, expect, it } from "vitest";
import { bytesToHex } from "../../../src/common/bytes.js";
import {
  computeWithdrawRequestHash,
  parseQuantity,
  quantityToWord,
} from "../../../src/common/abi.js";
import type { WithdrawRequest } from "../../../src/common/types.js";

const WITHDRAW_REQUEST: WithdrawRequest = {
  chainId: "ethereum-mainnet",
  depository: "0x1111111111111111111111111111111111111111",
  currency: "0x0000000000000000000000000000000000000000",
  amount: "10",
  spenderChainId: "ethereum-mainnet",
  spender: "0x2222222222222222222222222222222222222222",
  receiver: "0x3333333333333333333333333333333333333333",
  data: "0x",
  nonce: `0x${"01".repeat(32)}`,
};

describe("ABI utilities", () => {
  it("parses decimal and hex quantities", () => {
    expect(parseQuantity("10", "amount")).toBe(10n);
    expect(parseQuantity("0x10", "amount")).toBe(16n);
    expect(parseQuantity(10, "amount")).toBe(10n);
    expect(parseQuantity(10n, "amount")).toBe(10n);
    expect(() => parseQuantity("", "amount")).toThrow("invalid quantity");
    expect(() => parseQuantity("not-a-number", "amount")).toThrow();
  });

  it("encodes quantities as uint256 words", () => {
    expect(bytesToHex(quantityToWord(1, "value"))).toBe(`${"00".repeat(31)}01`);
    expect(bytesToHex(quantityToWord((1n << 256n) - 1n, "value"))).toBe("ff".repeat(32));
    expect(() => quantityToWord(-1, "value")).toThrow("does not fit uint256");
    expect(() => quantityToWord(1n << 256n, "value")).toThrow("does not fit uint256");
  });

  it("computes deterministic withdraw request hashes", () => {
    const hash = computeWithdrawRequestHash(WITHDRAW_REQUEST);
    expect(hash.length).toBe(32);
    expect(bytesToHex(hash)).toBe(
      "065c0857415365811df83616026821e32211b9acd866b51bcc3e119f8c4d97d9",
    );
    expect(bytesToHex(hash)).toBe(bytesToHex(computeWithdrawRequestHash(WITHDRAW_REQUEST)));
    expect(computeWithdrawRequestHash({ ...WITHDRAW_REQUEST, amount: "11" })).not.toEqual(hash);
  });

  it("rejects withdraw requests with invalid fixed fields", () => {
    expect(() => computeWithdrawRequestHash({ ...WITHDRAW_REQUEST, nonce: "0x01" })).toThrow(
      "nonce must be exactly 32 bytes",
    );
    expect(() => computeWithdrawRequestHash({ ...WITHDRAW_REQUEST, depository: "0xabc" })).toThrow(
      "invalid hex",
    );
  });
});
