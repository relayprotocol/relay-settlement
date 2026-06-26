import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import type { BitcoinVmTransaction } from "../../src/common/types.js";
import { deriveWallet, signTransactionsWithWallet } from "../../src/derivation/index.js";
import { PATH, ROOT_KEY, hexToBytes } from "./shared.js";

  describe("bitcoin-vm", () => {
    function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
      const out = new Uint8Array(parts.reduce((acc, p) => acc + p.length, 0));
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }

    function u32le(value: number): Uint8Array {
      return new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]);
    }

    function u64le(value: bigint): Uint8Array {
      const out = new Uint8Array(8);
      let v = value;
      for (let i = 0; i < 8; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    }

    function hash160(data: Uint8Array): Uint8Array {
      return ripemd160(sha256(data));
    }

    function doubleSha256(data: Uint8Array): Uint8Array {
      return sha256(sha256(data));
    }

    function buildBitcoinTx(publicKey: string): BitcoinVmTransaction {
      const publicKeyBytes = hexToBytes(publicKey);
      const inputValue = 60_000n;
      const outputValue = 50_000n;
      const txid = new Uint8Array(32).fill(0x22);
      const p2wpkhScript = concatBytes([new Uint8Array([0x00, 0x14]), hash160(publicKeyBytes)]);
      const output = concatBytes([
        u64le(outputValue),
        new Uint8Array([p2wpkhScript.length]),
        p2wpkhScript,
      ]);
      const unsignedBytes = concatBytes([
        u32le(1),
        new Uint8Array([1]),
        txid,
        u32le(0),
        new Uint8Array([0]),
        u32le(0xfffffffd),
        new Uint8Array([1]),
        output,
        u32le(0),
      ]);
      const scriptCode = concatBytes([
        new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
        hash160(publicKeyBytes),
        new Uint8Array([0x88, 0xac]),
      ]);
      const sighash = doubleSha256(
        concatBytes([
          u32le(1),
          doubleSha256(concatBytes([txid, u32le(0)])),
          doubleSha256(u32le(0xfffffffd)),
          txid,
          u32le(0),
          scriptCode,
          u64le(inputValue),
          u32le(0xfffffffd),
          doubleSha256(output),
          u32le(0),
          u32le(1),
        ]),
      );
      return {
        unsignedTransaction: `0x${Buffer.from(unsignedBytes).toString("hex")}`,
        inputValues: [inputValue.toString()],
        sighashes: [`0x${Buffer.from(sighash).toString("hex")}`],
      };
    }

    it("returns one verifiable compact signature per sighash", async () => {
      const wallet = await deriveWallet(ROOT_KEY, "bitcoin-vm", PATH);
      const tx = buildBitcoinTx(wallet.publicKey);
      const { signedTransactions } = await signTransactionsWithWallet(
        ROOT_KEY,
        "bitcoin-vm",
        PATH,
        [tx],
      );
      const [signed] = signedTransactions;

      expect(signed.signatures).toHaveLength(tx.sighashes.length);

      for (let i = 0; i < tx.sighashes.length; i++) {
        const signature = signed.signatures[i];
        expect(signature).toMatch(/^0x[0-9a-f]{128}$/u);
        expect(
          secp256k1.verify(
            hexToBytes(signature),
            hexToBytes(tx.sighashes[i]),
            hexToBytes(wallet.publicKey),
            { prehash: false },
          ),
        ).toBe(true);
      }
    });

    it("rejects empty sighash lists", async () => {
      await expect(
        signTransactionsWithWallet(ROOT_KEY, "bitcoin-vm", PATH, [
          { unsignedTransaction: "0x", inputValues: [], sighashes: [] },
        ]),
      ).rejects.toThrow("at least one sighash");
    });
  });
