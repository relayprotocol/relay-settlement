import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerializedLegacy,
} from "viem";
import type {
  BitcoinVmTransaction,
  EthereumVmTransaction,
  HyperliquidVmTransaction,
  SolanaVmTransaction,
} from "../src/common/types.js";
import { deriveWallet, signTransactionsWithWallet } from "../src/derivation/index.js";

const ROOT_KEY = `0x${"11".repeat(32)}`;
const PATH = [3, 5, 7, 9, 11, 13, 15, 17];

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

describe("transaction signing", () => {
  describe("ethereum-vm", () => {
    /** Build an unsigned EIP-1559 (type-2) transaction RLP-encoded as hex. */
    function buildEip1559(nonce: number): string {
      return serializeTransaction({
        type: "eip1559",
        to: "0x000000000000000000000000000000000000dead",
        value: 1_000_000_000_000_000n,
        data: "0x",
        nonce,
        gas: 21_000n,
        maxFeePerGas: 30_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        chainId: 11155111,
      });
    }

    /** Build an unsigned EIP-155 legacy transaction RLP-encoded as hex. */
    function buildLegacy(nonce: number, chainId = 1): string {
      return serializeTransaction({
        type: "legacy",
        to: "0x000000000000000000000000000000000000dead",
        value: 1_000_000_000_000_000n,
        data: "0x",
        nonce,
        gas: 21_000n,
        gasPrice: 20_000_000_000n,
        chainId,
      });
    }

    it("signs an EIP-1559 transaction and recovers to the wallet", async () => {
      const transaction: EthereumVmTransaction = { unsignedTransaction: buildEip1559(3) };
      const { wallet, signedTransactions } = await signTransactionsWithWallet(
        ROOT_KEY,
        "ethereum-vm",
        PATH,
        [transaction],
      );
      const [signed] = signedTransactions;

      expect(signed.rawTransaction.startsWith("0x02")).toBe(true);
      expect(signed.transactionHash).toMatch(/^0x[0-9a-f]{64}$/u);

      const parsed = parseTransaction(signed.rawTransaction as `0x02${string}`);
      expect(parsed.type).toBe("eip1559");
      expect(parsed.to?.toLowerCase()).toBe("0x000000000000000000000000000000000000dead");
      expect(parsed.value).toBe(1_000_000_000_000_000n);
      expect(parsed.nonce).toBe(3);
      expect(parsed.chainId).toBe(11155111);

      const recovered = await recoverTransactionAddress({
        serializedTransaction: signed.rawTransaction as `0x02${string}`,
      });
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it("signs an EIP-155 legacy transaction and recovers to the wallet", async () => {
      const transaction: EthereumVmTransaction = { unsignedTransaction: buildLegacy(7, 1) };
      const { wallet, signedTransactions } = await signTransactionsWithWallet(
        ROOT_KEY,
        "ethereum-vm",
        PATH,
        [transaction],
      );
      const [signed] = signedTransactions;

      const parsed = parseTransaction(signed.rawTransaction as TransactionSerializedLegacy);
      expect(parsed.type).toBe("legacy");
      expect(parsed.chainId).toBe(1);
      expect(parsed.nonce).toBe(7);
      // EIP-155 v is `35 + chainId * 2 + yParity` → 37 or 38 for chainId=1.
      expect([37n, 38n]).toContain(parsed.v);

      const recovered = await recoverTransactionAddress({
        serializedTransaction: signed.rawTransaction as TransactionSerializedLegacy,
      });
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it("rejects pre-EIP-155 legacy transactions", async () => {
      const preEip155 = serializeTransaction({
        type: "legacy",
        to: "0x000000000000000000000000000000000000dead",
        value: 1n,
        data: "0x",
        nonce: 2,
        gas: 21_000n,
        gasPrice: 20_000_000_000n,
      });
      await expect(
        signTransactionsWithWallet(ROOT_KEY, "ethereum-vm", PATH, [
          { unsignedTransaction: preEip155 },
        ]),
      ).rejects.toThrow("EIP-155 chainId");
    });

    it("signs multiple encoded transactions independently", async () => {
      const { signedTransactions } = await signTransactionsWithWallet(
        ROOT_KEY,
        "ethereum-vm",
        PATH,
        [{ unsignedTransaction: buildEip1559(3) }, { unsignedTransaction: buildEip1559(4) }],
      );
      expect(signedTransactions).toHaveLength(2);
      expect(signedTransactions[0].rawTransaction).not.toBe(signedTransactions[1].rawTransaction);
    });
  });

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

  describe("hyperliquid-vm", () => {
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
    const SPOT_USDC = "0x6d1e7cde53ba9467b783cb7c530ce054";
    const ORDER_ID = `0x${"ab".repeat(32)}` as `0x${string}`;
    const DEPOSITOR = "0x000000000000000000000000000000000000beef" as const;
    const DEPOSITORY = "0x00000000000000000000000000000000000000dd" as const;

    const NONCE_MAPPING_DOMAIN = {
      name: "RelayNonceMapping",
      version: "2",
      chainId: 1,
      verifyingContract: ZERO_ADDRESS,
    } as const;
    const NONCE_MAPPING_TYPES = {
      NonceMapping: [
        { name: "chainId", type: "string" },
        { name: "wallet", type: "address" },
        { name: "depositor", type: "address" },
        { name: "id", type: "bytes32" },
        { name: "nonce", type: "uint256" },
      ],
    } as const;

    const SEND_ASSET_TYPES = {
      "HyperliquidTransaction:SendAsset": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "sourceDex", type: "string" },
        { name: "destinationDex", type: "string" },
        { name: "token", type: "string" },
        { name: "amount", type: "string" },
        { name: "fromSubAccount", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
    } as const;

    async function buildTransaction(
      wallet: string,
      sendAssetOverrides: Partial<HyperliquidVmTransaction["sendAsset"]> = {},
    ): Promise<HyperliquidVmTransaction> {
      return {
        nonceMapping: {
          walletChainId: "hyperliquid",
          wallet,
          depositor: DEPOSITOR,
          id: ORDER_ID,
          nonce: "123456789",
        },
        sendAsset: {
          type: "sendAsset",
          signatureChainId: "0xa4b1",
          hyperliquidChain: "Mainnet",
          destination: DEPOSITORY,
          sourceDex: "",
          destinationDex: "",
          token: `USDC:${SPOT_USDC}`,
          amount: "1.23456789",
          fromSubAccount: "",
          nonce: 123456789,
          ...sendAssetOverrides,
        },
      };
    }

    it("derives EVM-style addresses for hyperliquid-vm", async () => {
      const wallet = await deriveWallet(ROOT_KEY, "hyperliquid-vm", PATH);
      expect(wallet.address).toMatch(/^0x[0-9a-f]{40}$/u);
    });

    it("signs the nonce mapping with the derived wallet under the canonical EIP-712 domain", async () => {
      const { recoverTypedDataAddress } = await import("viem");
      const wallet = await deriveWallet(ROOT_KEY, "hyperliquid-vm", PATH);
      const tx = await buildTransaction(wallet.address);
      const { signedTransactions } = await signTransactionsWithWallet(
        ROOT_KEY,
        "hyperliquid-vm",
        PATH,
        [tx],
      );
      const { nonceMapping } = signedTransactions[0];

      expect(nonceMapping.signature).toMatch(/^0x[0-9a-f]{130}$/u);
      const recovered = await recoverTypedDataAddress({
        domain: NONCE_MAPPING_DOMAIN,
        types: NONCE_MAPPING_TYPES,
        primaryType: "NonceMapping",
        message: {
          chainId: tx.nonceMapping.walletChainId,
          wallet: tx.nonceMapping.wallet as `0x${string}`,
          depositor: tx.nonceMapping.depositor as `0x${string}`,
          id: tx.nonceMapping.id as `0x${string}`,
          nonce: BigInt(tx.nonceMapping.nonce),
        },
        signature: nonceMapping.signature as `0x${string}`,
      });
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it("signs the sendAsset payload with the derived wallet using the request's signatureChainId", async () => {
      const { recoverTypedDataAddress } = await import("viem");
      const wallet = await deriveWallet(ROOT_KEY, "hyperliquid-vm", PATH);
      const signatureChainId = "0x66eee"; // hyperliquid testnet sig domain
      const tx = await buildTransaction(wallet.address, { signatureChainId });
      const { signedTransactions } = await signTransactionsWithWallet(
        ROOT_KEY,
        "hyperliquid-vm",
        PATH,
        [tx],
      );
      const { sendAsset } = signedTransactions[0];

      expect(sendAsset.signature).toMatch(/^0x[0-9a-f]{130}$/u);
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: "HyperliquidSignTransaction",
          version: "1",
          chainId: Number.parseInt(signatureChainId, 16),
          verifyingContract: ZERO_ADDRESS,
        },
        types: SEND_ASSET_TYPES,
        primaryType: "HyperliquidTransaction:SendAsset",
        message: {
          hyperliquidChain: tx.sendAsset.hyperliquidChain,
          destination: tx.sendAsset.destination,
          sourceDex: tx.sendAsset.sourceDex,
          destinationDex: tx.sendAsset.destinationDex,
          token: tx.sendAsset.token,
          amount: tx.sendAsset.amount,
          fromSubAccount: tx.sendAsset.fromSubAccount,
          nonce: BigInt(tx.sendAsset.nonce),
        },
        signature: sendAsset.signature as `0x${string}`,
      });
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it("rejects sign requests whose nonceMapping.wallet does not match the derived wallet", async () => {
      const tx = await buildTransaction("0x000000000000000000000000000000000000dead");
      await expect(
        signTransactionsWithWallet(ROOT_KEY, "hyperliquid-vm", PATH, [tx]),
      ).rejects.toThrow(/nonceMapping\.wallet must equal derived hyperliquid wallet/);
    });
  });

  it("rejects empty transaction lists", async () => {
    await expect(signTransactionsWithWallet(ROOT_KEY, "ethereum-vm", PATH, [])).rejects.toThrow(
      "at least one transaction",
    );
  });
});
