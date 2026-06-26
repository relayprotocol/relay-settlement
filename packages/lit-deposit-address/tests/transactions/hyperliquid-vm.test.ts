import { describe, expect, it } from "vitest";
import type { HyperliquidVmTransaction } from "../../src/common/types.js";
import { deriveWallet, signTransactionsWithWallet } from "../../src/derivation/index.js";
import { PATH, ROOT_KEY } from "./shared.js";

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
