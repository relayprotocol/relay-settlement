import { describe, expect, it } from "vitest";
import { decodeAddressFromHex, encodeAddressToHex } from "../src/common/address.js";
import type { VmType } from "../src/common/types.js";

const CASES: Array<{ vmType: VmType; address: string; encoded: string; decoded?: string }> = [
  {
    vmType: "ethereum-vm",
    address: "0x000000000000000000000000000000000000beef",
    encoded: "0x000000000000000000000000000000000000beef",
  },
  {
    vmType: "solana-vm",
    address: "11111111111111111111111111111111",
    encoded: `0x${"00".repeat(32)}`,
  },
  {
    vmType: "hyperliquid-vm",
    address: "0x000000000000000000000000000000000000beef",
    encoded: "0x000000000000000000000000000000000000beef",
  },
  {
    vmType: "hyperliquid-vm",
    address: "0x6d1e7cde53ba9467b783cb7c530ce054",
    encoded: "0x6d1e7cde53ba9467b783cb7c530ce054",
  },
  {
    vmType: "hyperliquid-vm",
    address: "0xbeef",
    encoded: "0xbeef",
  },
  {
    vmType: "bitcoin-vm",
    address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    encoded: "0xff0062e907b15cbf27d5425399ebf6f0fb50ebb88f18",
  },
  {
    vmType: "bitcoin-vm",
    address: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    encoded: "0xff05b472a266d0bd89c13706a4132ccfb16f7c3b9fcb",
  },
  {
    vmType: "bitcoin-vm",
    address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    encoded: "0x00751e76e8199196d454941c45d1b3a323f1433bd6",
  },
  {
    vmType: "ton-vm",
    address: `0:${"aa".repeat(32)}`,
    encoded: `0x${"aa".repeat(32)}`,
  },
  {
    vmType: "tron-vm",
    address: "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC",
    encoded: "0x417e5f4552091a69125d5dfcb7b8c2659029395bdf",
  },
  {
    // Friendly (url-safe, bounceable) form encodes to the same hash and
    // decodes back to the canonical raw form.
    vmType: "ton-vm",
    address: "EQCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqseb",
    encoded: `0x${"aa".repeat(32)}`,
    decoded: `0:${"aa".repeat(32)}`,
  },
];

describe("address encoding utilities", () => {
  for (const test of CASES) {
    it(`encodes ${test.vmType} address like settlement SDK`, () => {
      expect(encodeAddressToHex(test.address, test.vmType)).toBe(test.encoded);
    });

    it(`decodes ${test.vmType} address bytes like settlement SDK`, () => {
      expect(decodeAddressFromHex(test.encoded, test.vmType)).toBe(test.decoded ?? test.address);
    });
  }

  it("keeps ethereum-vm strict about 20-byte addresses", () => {
    expect(() => encodeAddressToHex("0xbeef", "ethereum-vm")).toThrow(
      /ethereum-vm address must be 20 bytes/,
    );
  });
});
