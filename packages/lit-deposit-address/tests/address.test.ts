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
});
