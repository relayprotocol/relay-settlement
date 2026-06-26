import {
  encodeHyperliquidAddressToHex,
  normalizeHyperliquidAddressHex,
} from "../../../common/address/hyperliquid.js";
import { hexToBytes } from "../../../common/bytes.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  HyperliquidVmTransaction,
} from "../../../common/types.js";

const NATIVE_CURRENCY = `0x${"00".repeat(16)}`;
const SPOT_USDC = "0x6d1e7cde53ba9467b783cb7c530ce054";

function currency(hex: string, label: string): string {
  const bytes = hexToBytes(hex, label);
  if (bytes.length !== 16) {
    throw new Error(`${label} must be 16 bytes`);
  }
  return hex.toLowerCase();
}

function rawAmount(decimal: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/u.test(decimal)) {
    throw new Error("sendAsset.amount must be an unsigned decimal string");
  }
  const [whole, frac = ""] = decimal.split(".");
  if (frac.length > decimals) {
    throw new Error(`sendAsset.amount has too many decimals: max=${decimals}, got=${frac.length}`);
  }
  return BigInt(`${whole}${frac.padEnd(decimals, "0")}`);
}

function inputCurrencyDecimals(trigger: DepositAddressTrigger): number {
  const i = trigger.currencies.findIndex(
    (c) =>
      c.chainId === trigger.input.chainId &&
      c.currency.toLowerCase() === trigger.input.currency.toLowerCase(),
  );
  if (i === -1) {
    throw new Error("input currency price/decimals missing from trigger");
  }
  return trigger.prices[i].currencyDecimals;
}

export function assertHyperliquidDeposit(
  trigger: DepositAddressTrigger,
  attestation: DepositAddressTriggerAttestation,
  tx: HyperliquidVmTransaction,
): void {
  const { nonceMapping, sendAsset } = tx;
  const inputCurrency = currency(trigger.input.currency, "trigger.input.currency");
  const isNative = inputCurrency === NATIVE_CURRENCY;
  const expectedDex = isNative ? "" : "spot";

  if (sendAsset.type !== "sendAsset") {
    throw new Error("hyperliquid action must be sendAsset");
  }
  if (sendAsset.hyperliquidChain !== "Mainnet") {
    throw new Error("sendAsset.hyperliquidChain must be Mainnet");
  }
  if (sendAsset.sourceDex !== expectedDex || sendAsset.destinationDex !== expectedDex) {
    throw new Error(
      `sendAsset sourceDex/destinationDex must both be ${JSON.stringify(expectedDex)}`,
    );
  }
  if (sendAsset.fromSubAccount !== "") {
    throw new Error("sendAsset.fromSubAccount must be empty");
  }
  if (BigInt(nonceMapping.nonce) !== BigInt(sendAsset.nonce)) {
    throw new Error("nonceMapping.nonce must equal sendAsset.nonce");
  }
  if (nonceMapping.walletChainId !== trigger.input.chainId) {
    throw new Error("nonceMapping.walletChainId must equal trigger.input.chainId");
  }
  if (nonceMapping.id.toLowerCase() !== trigger.orderId.toLowerCase()) {
    throw new Error("nonceMapping.id must equal trigger.orderId");
  }

  const expectedDepositor = normalizeHyperliquidAddressHex(trigger.derivationFields.depositor);
  const depositor = encodeHyperliquidAddressToHex(nonceMapping.depositor).toLowerCase();
  if (depositor !== expectedDepositor) {
    throw new Error(
      `nonceMapping.depositor mismatch: expected=${expectedDepositor}, got=${depositor}`,
    );
  }

  const expectedDestination = normalizeHyperliquidAddressHex(attestation.inputDepository);
  const destination = encodeHyperliquidAddressToHex(sendAsset.destination).toLowerCase();
  if (destination !== expectedDestination) {
    throw new Error(
      `sendAsset.destination mismatch: expected=${expectedDestination}, got=${destination}`,
    );
  }

  const [symbol, token] = sendAsset.token.split(":");
  if (!symbol || !token) {
    throw new Error("sendAsset.token must be SYMBOL:0x<16-byte-token>");
  }
  const tokenCurrency = currency(token, "sendAsset.token");
  if (isNative) {
    if (symbol !== "USDC" || tokenCurrency !== SPOT_USDC) {
      throw new Error(`native hyperliquid deposits must use USDC:${SPOT_USDC}`);
    }
  } else if (tokenCurrency !== inputCurrency) {
    throw new Error(`sendAsset token mismatch: expected=${inputCurrency}, got=${tokenCurrency}`);
  }

  const amount = rawAmount(sendAsset.amount, inputCurrencyDecimals(trigger));
  if (amount !== BigInt(trigger.input.amount)) {
    throw new Error(`sendAsset.amount mismatch: expected=${trigger.input.amount}, got=${amount}`);
  }
}
