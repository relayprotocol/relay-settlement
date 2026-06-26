import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import type { SolanaVmTransaction } from "../../src/common/types.js";
import { deriveWallet, signTransactionsWithWallet } from "../../src/derivation/index.js";
import { PATH, ROOT_KEY, base64ToBytes, hexToBytes } from "./shared.js";

  describe("solana-vm", () => {
    /**
     * Build a minimal valid compiled message:
     *   header [N, 0, N] || numKeys (shortvec) || N pubkeys || blockhash || 0 instructions
     *
     * `signerPubkeys[0]` is the fee payer; the LAST entry must be the deposit
     * wallet pubkey (the signer enforces wallet at slot N-1).
     */
    function buildMessage(signerPubkeys: Uint8Array[]): Uint8Array {
      if (signerPubkeys.length === 0 || signerPubkeys.length > 0x7f) {
        throw new Error("signerPubkeys length out of range");
      }
      const n = signerPubkeys.length;
      const header = new Uint8Array([n, 0, n]);
      const numKeys = new Uint8Array([n]); // shortvec: 1-127 fits in 1 byte
      const keys = new Uint8Array(n * 32);
      for (let i = 0; i < n; i++) {
        keys.set(signerPubkeys[i], i * 32);
      }
      const blockhash = new Uint8Array(32);
      const numIxs = new Uint8Array([0]);
      const total = new Uint8Array(
        header.length + numKeys.length + keys.length + blockhash.length + numIxs.length,
      );
      let off = 0;
      for (const part of [header, numKeys, keys, blockhash, numIxs]) {
        total.set(part, off);
        off += part.length;
      }
      return total;
    }

    it("returns a verifiable Ed25519 signed transaction (single signer)", async () => {
      const wallet = await deriveWallet(ROOT_KEY, "solana-vm", PATH);
      const message = buildMessage([bs58.decode(wallet.publicKey)]);
      const tx: SolanaVmTransaction = { message: Buffer.from(message).toString("base64") };
      const { signedTransactions } = await signTransactionsWithWallet(ROOT_KEY, "solana-vm", PATH, [
        tx,
      ]);
      const [signed] = signedTransactions;

      expect(signed.signature).toMatch(/^0x[0-9a-f]{128}$/u);

      const signedBytes = base64ToBytes(signed.rawTransaction);
      expect(signedBytes[0]).toBe(1);
      expect(signedBytes.slice(1, 65)).toEqual(hexToBytes(signed.signature));
      expect(signedBytes.slice(65)).toEqual(message);

      expect(
        ed25519.verify(hexToBytes(signed.signature), message, bs58.decode(wallet.publicKey)),
      ).toBe(true);
    });

    it("emits a 2-signer partial signed tx with the wallet sig at slot 1", async () => {
      const wallet = await deriveWallet(ROOT_KEY, "solana-vm", PATH);
      const feePayer = new Uint8Array(32).fill(0x11);
      const message = buildMessage([feePayer, bs58.decode(wallet.publicKey)]);
      const tx: SolanaVmTransaction = { message: Buffer.from(message).toString("base64") };
      const { signedTransactions } = await signTransactionsWithWallet(ROOT_KEY, "solana-vm", PATH, [
        tx,
      ]);
      const [signed] = signedTransactions;

      const signedBytes = base64ToBytes(signed.rawTransaction);
      // shortvec(N=2) + 2 * 64-byte sigs + message
      expect(signedBytes[0]).toBe(2);
      // slot 0: 64 zero bytes (fee payer signs externally).
      expect(signedBytes.slice(1, 65)).toEqual(new Uint8Array(64));
      // slot 1: the wallet's real signature.
      expect(signedBytes.slice(65, 129)).toEqual(hexToBytes(signed.signature));
      expect(signedBytes.slice(129)).toEqual(message);

      expect(
        ed25519.verify(hexToBytes(signed.signature), message, bs58.decode(wallet.publicKey)),
      ).toBe(true);
    });

    it("rejects messages with more than 2 required signatures", async () => {
      const wallet = await deriveWallet(ROOT_KEY, "solana-vm", PATH);
      const message = buildMessage([
        new Uint8Array(32).fill(0x11),
        new Uint8Array(32).fill(0x22),
        bs58.decode(wallet.publicKey),
      ]);
      await expect(
        signTransactionsWithWallet(ROOT_KEY, "solana-vm", PATH, [
          { message: Buffer.from(message).toString("base64") },
        ]),
      ).rejects.toThrow("only 1 or 2 required signatures");
    });

    it("rejects single-signer messages where the wallet isn't at slot 0", async () => {
      // 1 signer, but the lone key isn't the deposit wallet.
      const message = buildMessage([new Uint8Array(32).fill(0xaa)]);
      await expect(
        signTransactionsWithWallet(ROOT_KEY, "solana-vm", PATH, [
          { message: Buffer.from(message).toString("base64") },
        ]),
      ).rejects.toThrow("deposit wallet must occupy signer slot 0");
    });

    it("rejects two-signer messages where the wallet isn't at slot 1", async () => {
      const wallet = await deriveWallet(ROOT_KEY, "solana-vm", PATH);
      // Wallet at slot 0 (fee payer) instead of slot 1.
      const message = buildMessage([bs58.decode(wallet.publicKey), new Uint8Array(32).fill(0xaa)]);
      await expect(
        signTransactionsWithWallet(ROOT_KEY, "solana-vm", PATH, [
          { message: Buffer.from(message).toString("base64") },
        ]),
      ).rejects.toThrow("deposit wallet must occupy signer slot 1");
    });
  });
