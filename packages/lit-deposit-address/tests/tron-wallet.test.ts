import { describe, expect, it } from "vitest";
import {
  decodeTronAddress,
  encodeTronAddress,
  tronAddressFromPublicKey,
} from "../src/common/address/tron.js";

const PRIVATE_KEY_ONE_COMPRESSED_PUBLIC_KEY =
  "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PRIVATE_KEY_ONE_ADDRESS = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";
const PRIVATE_KEY_ONE_ADDRESS_BYTES = "417e5f4552091a69125d5dfcb7b8c2659029395bdf";

describe("Tron wallet address", () => {
  it("formats the canonical private-key-one public key vector", () => {
    expect(tronAddressFromPublicKey(PRIVATE_KEY_ONE_COMPRESSED_PUBLIC_KEY)).toBe(
      PRIVATE_KEY_ONE_ADDRESS,
    );
  });

  it("round-trips settlement-compatible address bytes", () => {
    const encoded = encodeTronAddress(PRIVATE_KEY_ONE_ADDRESS);

    expect(Buffer.from(encoded).toString("hex")).toBe(PRIVATE_KEY_ONE_ADDRESS_BYTES);
    expect(decodeTronAddress(encoded)).toBe(PRIVATE_KEY_ONE_ADDRESS);
  });

  it("rejects an address with a changed checksum", () => {
    expect(() => encodeTronAddress(`${PRIVATE_KEY_ONE_ADDRESS.slice(0, -1)}D`)).toThrow(
      "invalid Tron address checksum",
    );
  });

  it("rejects bytes without the Tron mainnet prefix", () => {
    const encoded = Uint8Array.from(Buffer.from(PRIVATE_KEY_ONE_ADDRESS_BYTES, "hex"));
    encoded[0] = 0x42;

    expect(() => decodeTronAddress(encoded)).toThrow("invalid Tron address prefix");
  });
});
