import { describe, expect, it } from "vitest";
import { bytesToHex } from "../../../src/common/bytes.js";
import { deriveKey, keccak } from "../../../src/common/crypto.js";

const TEST_KEY_HEX = "deadbeef".repeat(8);

describe("crypto utilities", () => {
  it("computes known Keccak-256 hashes", () => {
    expect(bytesToHex(keccak(new Uint8Array()))).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("derives deterministic VM-specific HKDF keys", async () => {
    await expect(deriveKey(TEST_KEY_HEX, "ethereum-vm").then(bytesToHex)).resolves.toBe(
      "78d9b0e5c1250df3b93fd26e5e214c60815f2e1117505372beff0cefbda7d18a",
    );
    await expect(deriveKey(TEST_KEY_HEX, "solana-vm").then(bytesToHex)).resolves.toBe(
      "a3bc86e5483a8e78aa7998511b6cf252f3c457e8f02e9679b485e85d7ebd0f3b",
    );
  });

  it("derives distinct keys for distinct VM info strings", async () => {
    const ethereum = await deriveKey(TEST_KEY_HEX, "ethereum-vm");
    const solana = await deriveKey(TEST_KEY_HEX, "solana-vm");
    expect(ethereum).not.toEqual(solana);
  });
});
