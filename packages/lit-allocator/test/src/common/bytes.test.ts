import { describe, expect, it } from "vitest";
import {
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  concatBytes,
  equalBytes,
  expectLength,
  hexToBytes,
  normalizeHex,
} from "../../../src/common/bytes.js";

/** Convert bytes to a normal array for terse assertions. */
function toArray(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

describe("byte utilities", () => {
  it("normalizes and validates hex strings", () => {
    expect(normalizeHex("0xAaBb")).toBe("aabb");
    expect(normalizeHex("0XAaBb")).toBe("aabb");
    expect(normalizeHex("AaBb")).toBe("aabb");
    expect(normalizeHex("")).toBe("");
    expect(() => normalizeHex("abc")).toThrow("invalid hex");
    expect(() => normalizeHex("zz")).toThrow("invalid hex");
  });

  it("converts between hex and bytes", () => {
    const bytes = hexToBytes("0x000102ff");
    expect(toArray(bytes)).toEqual([0, 1, 2, 255]);
    expect(bytesToHex(bytes)).toBe("000102ff");
  });

  it("concatenates byte arrays", () => {
    expect(toArray(concatBytes(new Uint8Array([1, 2]), new Uint8Array([3])))).toEqual([1, 2, 3]);
  });

  it("compares byte arrays", () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });

  it("converts between bigint and minimal big-endian bytes", () => {
    expect(toArray(bigIntToBytes(0n))).toEqual([]);
    expect(bytesToHex(bigIntToBytes(0x0102ffn))).toBe("0102ff");
    expect(bytesToHex(bigIntToBytes(0x0fn))).toBe("0f");
    expect(bytesToBigInt(new Uint8Array())).toBe(0n);
    expect(bytesToBigInt(new Uint8Array([1, 2, 255]))).toBe(0x0102ffn);
  });

  it("validates fixed byte lengths", () => {
    const bytes = new Uint8Array([1, 2]);
    expect(expectLength(bytes, 2, "field")).toBe(bytes);
    expect(() => expectLength(bytes, 3, "field")).toThrow("field must be exactly 3 bytes");
  });
});
