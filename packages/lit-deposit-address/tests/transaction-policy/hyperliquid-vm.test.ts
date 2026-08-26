import { describe, expect, it } from "vitest";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  HyperliquidVmTransaction,
} from "../../src/common/types.js";
import { verifyTransactionsWithWallet } from "../../src/derivation/index.js";
import { makeAttestation, makeTrigger, ORDER_ID } from "./shared.js";

describe("hyperliquid-vm transaction policy", () => {
  const HL_NATIVE = `0x${"00".repeat(16)}`;
  const HL_TOKEN = "0x6d1e7cde53ba9467b783cb7c530ce054";
  const HL_DEPOSITORY = "0x00000000000000000000000000000000000000dd";
  const HL_DEPOSITOR = "0x0000000000000000000000000000000000000abc";
  const HL_WALLET = "0x0000000000000000000000000000000000000def";

  function hyperTrigger(currency = HL_NATIVE): DepositAddressTrigger {
    const trigger = makeTrigger({ inputVmType: "hyperliquid-vm", inputCurrency: currency });
    trigger.input.chainId = "hyperliquid-mainnet";
    trigger.input.amount = "123456789";
    trigger.derivationFields.depositor = HL_DEPOSITOR;
    trigger.currencies = [{ chainId: trigger.input.chainId, currency }];
    trigger.prices = [
      {
        usdPrice: "100000000",
        usdPriceDecimals: 8,
        currencyDecimals: 8,
        publishTime: "1735689500",
        expiration: "9999999999",
      },
    ];
    return trigger;
  }

  function hyperAttestation(): DepositAddressTriggerAttestation {
    return { ...makeAttestation(), inputDepository: HL_DEPOSITORY };
  }

  function hyperTx(
    overrides: Partial<HyperliquidVmTransaction["sendAsset"]> = {},
  ): HyperliquidVmTransaction {
    return {
      nonceMapping: {
        walletChainId: "hyperliquid-mainnet",
        wallet: HL_WALLET,
        depositor: HL_DEPOSITOR,
        id: ORDER_ID,
        nonce: "12345",
      },
      sendAsset: {
        type: "sendAsset",
        signatureChainId: "0xa4b1",
        hyperliquidChain: "Mainnet",
        destination: HL_DEPOSITORY,
        sourceDex: "",
        destinationDex: "",
        token: `USDC:${HL_TOKEN}`,
        amount: "1.23456789",
        fromSubAccount: "",
        nonce: 12345,
        ...overrides,
      },
    };
  }

  it("accepts one nonce mapping plus one native sendAsset", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [hyperTx()]),
    ).not.toThrow();
  });

  it("requires Mainnet sendAsset", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ hyperliquidChain: "Testnet" as "Mainnet" }),
      ]),
    ).toThrow(/hyperliquidChain must be Mainnet/);
  });

  it("requires empty dexes for native currency", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ sourceDex: "spot" }),
      ]),
    ).toThrow(/sourceDex\/destinationDex/);
  });

  it("requires spot dexes for non-native currency", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(HL_TOKEN), hyperAttestation(), [hyperTx()]),
    ).toThrow(/sourceDex\/destinationDex/);
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(HL_TOKEN), hyperAttestation(), [
        hyperTx({ sourceDex: "spot", destinationDex: "spot", token: `HYPE:${HL_TOKEN}` }),
      ]),
    ).not.toThrow();
  });

  it("requires nonceMapping.nonce to equal sendAsset.nonce", () => {
    const tx = hyperTx();
    tx.nonceMapping.nonce = "99999";
    expect(() => verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [tx])).toThrow(
      /nonceMapping\.nonce must equal sendAsset\.nonce/,
    );
  });

  it("requires nonceMapping.walletChainId to equal trigger.input.chainId", () => {
    const tx = hyperTx();
    tx.nonceMapping.walletChainId = "not-hyperliquid";
    expect(() => verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [tx])).toThrow(
      /nonceMapping\.walletChainId must equal trigger\.input\.chainId/,
    );
  });

  it("requires nonceMapping.id to equal trigger.orderId", () => {
    const tx = hyperTx();
    tx.nonceMapping.id = `0x${"cd".repeat(32)}`;
    expect(() => verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [tx])).toThrow(
      /nonceMapping\.id must equal trigger\.orderId/,
    );
  });

  it("requires nonceMapping.depositor to match derivationFields.depositor", () => {
    const tx = hyperTx();
    tx.nonceMapping.depositor = "0x0000000000000000000000000000000000000999";
    expect(() => verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [tx])).toThrow(
      /nonceMapping\.depositor mismatch/,
    );
  });

  it("rejects sendAsset.fromSubAccount that is not empty", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ fromSubAccount: "0x000000000000000000000000000000000000abcd" }),
      ]),
    ).toThrow(/sendAsset\.fromSubAccount must be empty/);
  });

  it("rejects sendAsset.destination that does not match attestation.inputDepository", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ destination: "0x0000000000000000000000000000000000000123" }),
      ]),
    ).toThrow(/sendAsset\.destination mismatch/);
  });

  it("rejects malformed sendAsset.token (missing SYMBOL prefix)", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ token: HL_TOKEN }),
      ]),
    ).toThrow(/sendAsset\.token must be SYMBOL/);
  });

  it("rejects native deposits whose token is not USDC:<SPOT_USDC>", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ token: `HYPE:${HL_TOKEN}` }),
      ]),
    ).toThrow(/native hyperliquid deposits must use USDC/);
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ token: `USDC:0x${"00".repeat(16)}` }),
      ]),
    ).toThrow(/native hyperliquid deposits must use USDC/);
  });

  it("rejects non-native deposits whose token id does not match trigger.input.currency", () => {
    const otherToken = "0x11111111111111111111111111111111";
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(HL_TOKEN), hyperAttestation(), [
        hyperTx({
          sourceDex: "spot",
          destinationDex: "spot",
          token: `HYPE:${otherToken}`,
        }),
      ]),
    ).toThrow(/sendAsset token mismatch/);
  });

  it("rejects sendAsset.amount with more decimals than the trigger currency", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ amount: "1.123456789" }),
      ]),
    ).toThrow(/sendAsset\.amount has too many decimals/);
  });

  it("rejects sendAsset.amount that does not equal trigger.input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ amount: "1.00000000" }),
      ]),
    ).toThrow(/sendAsset\.amount mismatch/);
  });

  it("rejects when the input currency is missing from trigger.currencies", () => {
    const trigger = hyperTrigger();
    trigger.currencies = [{ chainId: trigger.input.chainId, currency: HL_TOKEN }];
    trigger.prices = [
      {
        usdPrice: "100000000",
        usdPriceDecimals: 8,
        currencyDecimals: 8,
        publishTime: "1735689500",
        expiration: "9999999999",
      },
    ];
    expect(() => verifyTransactionsWithWallet(trigger, hyperAttestation(), [hyperTx()])).toThrow(
      /input currency price\/decimals missing from trigger/,
    );
  });
});
