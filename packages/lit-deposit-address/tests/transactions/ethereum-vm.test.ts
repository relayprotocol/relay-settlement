import { describe, expect, it } from "vitest";
import {
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerializedLegacy,
} from "viem";
import type { EthereumVmTransaction } from "../../src/common/types.js";
import { signTransactionsWithWallet } from "../../src/derivation/index.js";
import { PATH, ROOT_KEY } from "./shared.js";

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
