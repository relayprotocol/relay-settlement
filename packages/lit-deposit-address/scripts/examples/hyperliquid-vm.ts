#!/usr/bin/env tsx
/**
 * Self-contained hyperliquid-vm deposit-address sweep (native USDC perp +
 * spot tokens).
 *
 * Hyperliquid isn't an EVM chain — deposits are signed Hyperliquid actions
 * submitted to its `/exchange` HTTPS endpoint, not on-chain transactions.
 * The Lit Action signs the user-side EIP-712 payload; we wrap it in
 * Hyperliquid's action envelope and POST it.
 *
 * Pipeline:
 *   1. Derive the deposit address (Lit Action `account` + `wallet`, plus
 *      off-TEE parity check).
 *   2. Top the deposit address up from `HYPERLIQUID_VM_PRIVATE_KEY` via a
 *      `sendAsset` action (funder signs locally + POSTs to /exchange).
 *      Skipped when the deposit address already holds enough.
 *   3. Build a locally-signed order, submit `trigger()` on the Base hub
 *      from `HUB_PRIVATE_KEY`.
 *   4. Request an oracle attestation.
 *   5. Build the deposit `sendAsset` (+ Relay `nonceMapping`) payload,
 *      have the Lit Action sign both inside the TEE.
 *   6. POST the signed `nonceMapping` to the Relay solver authorize
 *      endpoint (`/execute/authorize/v1`) so the solver can bind the
 *      Hyperliquid nonce to the order before the deposit is broadcast.
 *   7. Wrap the signed `sendAsset` in Hyperliquid's exchange-action
 *      envelope and POST to `/exchange`.
 *
 * Required env:
 *   LIT_ENV                          environment name
 *   LIT_USAGE_API_KEY                Chipotle usage API key authorized for the action
 *   LIT_PKP_ID                       PKP wallet address used by the action
 *   HUB_RPC_URL                      Base hub RPC URL
 *   HUB_PRIVATE_KEY                  EVM key that submits trigger() on Base
 *   HYPERLIQUID_VM_API_URL           Hyperliquid REST API base URL
 *                                    (https://api.hyperliquid.xyz or
 *                                    https://api.hyperliquid-testnet.xyz)
 *   HYPERLIQUID_VM_PRIVATE_KEY       EVM 0x-prefixed key. Acts as the
 *                                    funder, depositor, and refund recipient
 *                                    on Hyperliquid.
 *   HYPERLIQUID_VM_CHAIN_ID          Relay chain slug; must match the slug
 *                                    used by `@relay-protocol/networks`
 *                                    (currently `"hyperliquid"`). The
 *                                    solver maps its internal solver-chain
 *                                    id (1337) to this slug when recovering
 *                                    the nonce-mapping signature, so any
 *                                    mismatch yields "invalid signature"
 *                                    from `/authorize`.
 *   HYPERLIQUID_VM_CURRENCY          16-byte hex token id; pass
 *                                    `0x${"00".repeat(16)}` for native
 *                                    USDC perp.
 *   HYPERLIQUID_VM_CURRENCY_SYMBOL   token symbol (e.g. "USDC", "HYPE")
 *   HYPERLIQUID_VM_CURRENCY_DECIMALS decimals to parse the amount with
 *   HYPERLIQUID_VM_AMOUNT            decimal string in whole units
 *   SOLVER_PRIVATE_KEY               EVM solver key used to authorize the order
 *
 *   RELAY_ORACLE_URL                 oracle base URL.
 *   RELAY_SOLVER_URL                 solver base URL.
 *
 * Optional env:
 *   HYPERLIQUID_VM_SIGNATURE_CHAIN_ID
 *                                    Hyperliquid EIP-712 domain chainId
 *                                    (e.g. "0xa4b1" for mainnet or
 *                                    "0x66eee" for testnet). Default: "1".
 *   HYPERLIQUID_VM_HYPERLIQUID_CHAIN
 *                                    "Mainnet" | "Testnet". Default:
 *                                    "Mainnet".
 */

import { randomBytes } from "node:crypto";
import { bytesToBigInt, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeAddress,
  getOrderId,
  type Order,
  type VmType as SdkVmType,
} from "@relay-protocol/settlement-sdk";
import {
  DEFAULT_BASE_URL,
  executeLitAction,
  type DepositAddressesClient,
} from "../client/index.js";
import {
  deriveDepositWallet,
  type AccountResponse,
  type DerivationFields,
  type LocalWalletInfo,
} from "../client/local-derivation.js";
import { addSolverRequestSignature } from "./solver-request.js";
import {
  buildChainsConfig,
  createHubClient,
  createSolverContext,
  encodePricesExtraData,
  loadCommonEnv,
  logSection,
  placeholderPrice,
  requestAttestation,
  requireEnv,
  submitTrigger,
} from "./lib/common.js";

// ─── Env / args ─────────────────────────────────────────────────────────────

const common = loadCommonEnv();
const apiUrl = requireEnv("HYPERLIQUID_VM_API_URL", "Hyperliquid REST API base URL").replace(
  /\/+$/,
  "",
);
const funderPrivateKey = requireEnv(
  "HYPERLIQUID_VM_PRIVATE_KEY",
  "EVM key — funder + depositor + refund recipient (0x-prefixed)",
) as Hex;
const chainSlug = requireEnv(
  "HYPERLIQUID_VM_CHAIN_ID",
  'Relay chain slug for Hyperliquid (e.g. "hyperliquid-mainnet")',
);
const currency = requireEnv(
  "HYPERLIQUID_VM_CURRENCY",
  "16-byte hex token id; pass 0x0..0 (16 zero bytes) for native USDC perp",
);
const currencySymbol = requireEnv(
  "HYPERLIQUID_VM_CURRENCY_SYMBOL",
  'token symbol (e.g. "USDC", "HYPE")',
);
const currencyDecimalsStr = requireEnv(
  "HYPERLIQUID_VM_CURRENCY_DECIMALS",
  "decimals to parse HYPERLIQUID_VM_AMOUNT with",
);
const amountFloat = requireEnv(
  "HYPERLIQUID_VM_AMOUNT",
  'deposit amount as a decimal string (e.g. "1.5")',
);
const solverUrl = requireEnv("RELAY_SOLVER_URL", "solver base URL").replace(/\/+$/, "");
const signatureChainId = process.env.HYPERLIQUID_VM_SIGNATURE_CHAIN_ID?.trim() ?? "1";
const hyperliquidChainValue = process.env.HYPERLIQUID_VM_HYPERLIQUID_CHAIN?.trim() ?? "Mainnet";
if (hyperliquidChainValue !== "Mainnet" && hyperliquidChainValue !== "Testnet") {
  console.error(
    `HYPERLIQUID_VM_HYPERLIQUID_CHAIN must be "Mainnet" or "Testnet"; got ${hyperliquidChainValue}`,
  );
  process.exit(1);
}
const hyperliquidChain = hyperliquidChainValue as "Mainnet" | "Testnet";

// ─── Currency / amount validation ───────────────────────────────────────────

const NATIVE_HL_CURRENCY = `0x${"00".repeat(16)}`;
const SPOT_USDC = "0x6d1e7cde53ba9467b783cb7c530ce054";

function normalizeHexBytes(value: string, byteLen: number, name: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(value) || (value.length - 2) / 2 !== byteLen) {
    console.error(`${name} must be a 0x-prefixed ${byteLen}-byte hex string; got ${value}`);
    process.exit(1);
  }
  return value.toLowerCase();
}
const currencyHex = normalizeHexBytes(currency, 16, "HYPERLIQUID_VM_CURRENCY");
const isNative = currencyHex === NATIVE_HL_CURRENCY;
const expectedDex = isNative ? "" : "spot";
// The Lit Action enforces native deposits use USDC routed through the spot
// USDC token id, even though it's a perp transfer (sourceDex = "").
const sendAssetToken = isNative ? `USDC:${SPOT_USDC}` : `${currencySymbol}:${currencyHex}`;

const currencyDecimals = Number.parseInt(currencyDecimalsStr, 10);
if (!Number.isInteger(currencyDecimals) || currencyDecimals < 0 || currencyDecimals > 36) {
  console.error(
    `HYPERLIQUID_VM_CURRENCY_DECIMALS must be an integer in [0, 36]; got ${currencyDecimalsStr}`,
  );
  process.exit(1);
}
let amount: bigint;
try {
  amount = parseUnits(amountFloat, currencyDecimals);
} catch (e) {
  console.error(
    `HYPERLIQUID_VM_AMOUNT must parse as a decimal with ${currencyDecimals} decimals; got ${amountFloat} (${
      e instanceof Error ? e.message : e
    })`,
  );
  process.exit(1);
}
if (amount <= 0n) {
  console.error(`HYPERLIQUID_VM_AMOUNT must be > 0; got ${amountFloat}`);
  process.exit(1);
}

// ─── Wallets ────────────────────────────────────────────────────────────────

const funder = privateKeyToAccount(funderPrivateKey);
const hub = createHubClient(common);
const { solver, solverChainIdForOrder, solverVirtual } = createSolverContext(
  common.solverPrivateKey,
);

// ─── Derivation fields + input ──────────────────────────────────────────────

const input = {
  vmType: "hyperliquid-vm" as const,
  chainId: chainSlug,
  currency: currencyHex,
  amount: amount.toString(),
};
const funderHex = funder.address.toLowerCase();
const derivationFields: DerivationFields = {
  inputVmType: "hyperliquid-vm",
  outputVmType: "ethereum-vm",
  outputChainId: "base",
  outputCurrency: "0x0000000000000000000000000000000000000000",
  outputRecipient: hub.hubSigner.address.toLowerCase(),
  solver: solverVirtual,
  pricingOracle: "0xaf0e1fe8897d2f14209aa8330953917f89f278a2",
  depositor: funderHex,
  refundRecipient: funderHex,
  priceImpactBps: "200",
  salt: bytesToBigInt(randomBytes(32)).toString(),
};

console.log(`==> funder / depositor / refund (hl evm):  ${funder.address}`);
console.log(`==> hub trigger submitter (evm):           ${hub.hubSigner.address}`);
console.log(
  `==> solver (evm):                          ${solver.address} (virtual ${solverVirtual})`,
);
console.log(`==> chain:                                 ${chainSlug} (${hyperliquidChain})`);
console.log(
  `==> currency:                              ${currencyHex}${isNative ? " (native USDC perp)" : ` (spot ${currencySymbol})`} (decimals=${currencyDecimals})`,
);
console.log(`==> amount:                                ${amountFloat} (${amount} base units)`);
console.log(`==> hl api:                                ${apiUrl}`);
console.log();

// ─── Hyperliquid helpers ────────────────────────────────────────────────────

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
const HL_DOMAIN = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: Number.parseInt(signatureChainId, 16),
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

interface SendAssetMessage {
  hyperliquidChain: "Mainnet" | "Testnet";
  destination: string;
  sourceDex: "" | "spot";
  destinationDex: "" | "spot";
  token: string;
  amount: string;
  fromSubAccount: string;
  nonce: number;
}

async function postExchange(action: Record<string, unknown>, signature: Hex): Promise<unknown> {
  // Hyperliquid splits the 65-byte signature into r/s/v for the request body.
  const sigBytes = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (sigBytes.length !== 130) {
    throw new Error(`expected 65-byte signature, got ${sigBytes.length / 2} bytes`);
  }
  const sig = {
    r: `0x${sigBytes.slice(0, 64)}`,
    s: `0x${sigBytes.slice(64, 128)}`,
    v: Number.parseInt(sigBytes.slice(128, 130), 16),
  };
  const res = await fetch(`${apiUrl}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce: action.nonce, signature: sig }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Hyperliquid /exchange failed (HTTP ${res.status}): ${body}`);
  }
  return JSON.parse(body);
}

async function postInfo<T>(payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${apiUrl}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid /info failed (HTTP ${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/**
 * Resolve the deposit address's available balance for the configured
 * currency. Returns the amount in base units.
 */
async function fetchDepositBalance(address: Address): Promise<bigint> {
  if (isNative) {
    // Perp account value (USDC). Hyperliquid uses 6-decimal USDC; we let
    // the user override via HYPERLIQUID_VM_CURRENCY_DECIMALS if a future
    // deployment differs.
    const state = await postInfo<{ marginSummary?: { accountValue?: string } }>({
      type: "clearinghouseState",
      user: address,
    });
    const value = state.marginSummary?.accountValue ?? "0";
    try {
      return parseUnits(value, currencyDecimals);
    } catch {
      return 0n;
    }
  }
  const state = await postInfo<{
    balances?: Array<{ coin?: string; total?: string }>;
  }>({
    type: "spotClearinghouseState",
    user: address,
  });
  const entry = state.balances?.find((b) => b.coin === currencySymbol);
  if (!entry?.total) {
    return 0n;
  }
  try {
    return parseUnits(entry.total, currencyDecimals);
  } catch {
    return 0n;
  }
}

// ─── 1. Derive deposit address ──────────────────────────────────────────────

const client: DepositAddressesClient = {
  apiBaseUrl: DEFAULT_BASE_URL,
  apiKey: common.usageApiKey,
  pkpId: common.pkpId,
  envName: common.envName,
  vmType: "hyperliquid-vm",
};

const account = (await executeLitAction(client, {
  action: "account",
  vmType: "hyperliquid-vm",
})) as AccountResponse;
const remoteWallet = (await executeLitAction(client, {
  action: "wallet",
  derivationFields,
})) as LocalWalletInfo;
const localWallet = await deriveDepositWallet(account, derivationFields);
if (remoteWallet.address.toLowerCase() !== localWallet.address.toLowerCase()) {
  console.error(
    `✗ deposit address mismatch: action=${remoteWallet.address}, local=${localWallet.address}`,
  );
  process.exit(1);
}
const depositAddress = remoteWallet.address.toLowerCase() as Address;
console.log(`==> deposit address: ${depositAddress}`);
console.log();

// ─── 2. Fund the deposit address (if needed) ────────────────────────────────

async function signSendAsset(
  signer: ReturnType<typeof privateKeyToAccount>,
  msg: SendAssetMessage,
): Promise<Hex> {
  return signer.signTypedData({
    domain: HL_DOMAIN,
    types: SEND_ASSET_TYPES,
    primaryType: "HyperliquidTransaction:SendAsset",
    message: { ...msg, nonce: BigInt(msg.nonce) },
  });
}

const fundingBalance = await fetchDepositBalance(depositAddress);
console.log(
  `==> deposit ${currencySymbol} balance: ${formatUnits(fundingBalance, currencyDecimals)} (${fundingBalance} base units)`,
);
if (fundingBalance >= amount) {
  console.log(`==> skipping funding: balance >= amount`);
} else {
  const shortfall = amount - fundingBalance;
  const shortfallDecimal = formatUnits(shortfall, currencyDecimals);
  console.log(`==> funding deposit address with ${shortfallDecimal} ${currencySymbol}`);
  const funderBalance = await fetchDepositBalance(funder.address.toLowerCase() as Address);
  if (funderBalance < shortfall) {
    console.error(
      `✗ funder ${currencySymbol} balance (${formatUnits(funderBalance, currencyDecimals)}) is below the shortfall (${shortfallDecimal}); top up before retrying`,
    );
    process.exit(1);
  }
  const fundingMsg: SendAssetMessage = {
    hyperliquidChain,
    destination: depositAddress,
    sourceDex: expectedDex,
    destinationDex: expectedDex,
    token: sendAssetToken,
    amount: shortfallDecimal,
    fromSubAccount: "",
    nonce: Date.now(),
  };
  const sig = await signSendAsset(funder, fundingMsg);
  const resp = await postExchange(
    {
      type: "sendAsset",
      ...fundingMsg,
      signatureChainId,
    },
    sig,
  );
  logSection("funding sendAsset response", resp);
}
console.log();

// ─── 3. Build order + submit trigger ────────────────────────────────────────

const currencies = [
  { chainId: chainSlug, currency: currencyHex as Hex },
  { chainId: derivationFields.outputChainId, currency: derivationFields.outputCurrency as Hex },
] as const;
const prices = currencies.map(() => placeholderPrice(currencyDecimals));
const extraData = encodePricesExtraData(prices);
const nonceBig = bytesToBigInt(randomBytes(32));

const outputMin = ((amount * 9900n) / 10000n).toString();
const order: Order = {
  version: "v1",
  solverChainId: solverChainIdForOrder,
  solver: solver.address.toLowerCase(),
  salt: ("0x" + randomBytes(32).toString("hex")) as Hex,
  inputs: [
    {
      payment: {
        chainId: chainSlug,
        currency: currencyHex,
        amount: amount.toString(),
        weight: "1",
      },
      refunds: [
        {
          chainId: chainSlug,
          recipient: funder.address.toLowerCase(),
          currency: currencyHex,
          minimumAmount: amount.toString(),
          deadline: 0xffff_ffff,
          extraData: "0x",
        },
      ],
    },
  ],
  output: {
    chainId: derivationFields.outputChainId,
    payments: [
      {
        recipient: derivationFields.outputRecipient,
        currency: derivationFields.outputCurrency,
        minimumAmount: outputMin,
        expectedAmount: amount.toString(),
      },
    ],
    calls: [],
    deadline: 0xffff_ffff,
    extraData: "0x",
  },
  fees: [],
};
const chainsConfig: Record<string, SdkVmType> = buildChainsConfig(chainSlug, "hyperliquid-vm");
const orderId = getOrderId(order, chainsConfig) as Hex;
const orderSignature = await solver.signMessage({ message: { raw: orderId } });

/**
 * Normalize order address-like fields to bytes-hex; the action's
 * `verifyOrderData` compares the normalized order against the trigger
 * fields, which are already bytes-hex.
 */
function encodeAddressForChain(addr: string, chainId: string): string {
  const vm = chainsConfig[chainId];
  if (!vm) {
    throw new Error(`unknown chainId in order normalization: ${chainId}`);
  }
  return `0x${Buffer.from(encodeAddress(addr, vm)).toString("hex")}`;
}
const normalizedOrder: Order = {
  ...order,
  inputs: order.inputs.map((inp) => ({
    payment: {
      ...inp.payment,
      currency: encodeAddressForChain(inp.payment.currency, inp.payment.chainId),
    },
    refunds: inp.refunds.map((r) => ({
      ...r,
      recipient: encodeAddressForChain(r.recipient, r.chainId),
      currency: encodeAddressForChain(r.currency, r.chainId),
    })),
  })),
  output: {
    ...order.output,
    payments: order.output.payments.map((p) => ({
      ...p,
      recipient: encodeAddressForChain(p.recipient, order.output.chainId),
      currency: encodeAddressForChain(p.currency, order.output.chainId),
    })),
  },
};

await submitTrigger(hub, {
  input: { ...input, currency: input.currency as Hex, amount },
  derivationFields: {
    ...derivationFields,
    outputCurrency: derivationFields.outputCurrency as Hex,
    outputRecipient: derivationFields.outputRecipient as Hex,
    solver: derivationFields.solver as Address,
    pricingOracle: derivationFields.pricingOracle as Address,
    depositor: derivationFields.depositor as Hex,
    refundRecipient: derivationFields.refundRecipient as Hex,
    priceImpactBps: BigInt(derivationFields.priceImpactBps),
    salt: BigInt(derivationFields.salt),
  },
  orderId,
  nonce: nonceBig,
  currencies,
  extraData,
});

// ─── 4. Oracle attestation ──────────────────────────────────────────────────

const attestation = await requestAttestation(common.oracleUrl, {
  input,
  derivationFields: derivationFields as unknown as Record<string, unknown>,
  orderId,
  nonce: nonceBig,
  currencies,
  prices,
  extraData,
});

// ─── 5. Build sweep payload + Lit Action sign ───────────────────────────────

const inputDepository = attestation.inputDepository.toLowerCase();
const sweepNonce = Date.now();
const sweepMsg: SendAssetMessage = {
  hyperliquidChain,
  destination: inputDepository,
  sourceDex: expectedDex,
  destinationDex: expectedDex,
  token: sendAssetToken,
  amount: amountFloat,
  fromSubAccount: "",
  nonce: sweepNonce,
};
logSection("sweep sendAsset (unsigned)", sweepMsg);

const signRequest = await addSolverRequestSignature(
  {
    pkpId: common.pkpId,
    action: "sign",
    trigger: {
      input,
      derivationFields,
      orderId,
      nonce: nonceBig.toString(),
      currencies,
      prices: prices.map((p) => ({
        usdPrice: p.usdPrice.toString(),
        usdPriceDecimals: p.usdPriceDecimals,
        currencyDecimals: p.currencyDecimals,
        publishTime: p.publishTime.toString(),
        expiration: p.expiration.toString(),
      })),
      extraData,
    },
    attestation: {
      chainId: Number(attestation.chainId),
      depositAddressManager: attestation.depositAddressManager,
      inputDepository: attestation.inputDepository,
      triggerHash: attestation.triggerHash,
      signatures: attestation.signatures,
    },
    order: normalizedOrder as unknown as Record<string, unknown>,
    orderSignature,
    transactions: [
      {
        nonceMapping: {
          walletChainId: chainSlug,
          wallet: depositAddress,
          depositor: derivationFields.depositor,
          id: orderId,
          nonce: sweepNonce.toString(),
        },
        sendAsset: {
          type: "sendAsset",
          signatureChainId,
          ...sweepMsg,
        },
      },
    ],
  },
  solver,
);
const signResult = (await executeLitAction(client, signRequest)) as {
  wallet: LocalWalletInfo;
  triggerHash: string;
  signedTransactions: Array<{
    nonceMapping: { digest: string; signature: string };
    sendAsset: { digest: string; signature: string };
  }>;
};
logSection("lit action sign response", signResult);

// ─── 6. Authorize nonce mapping with the Relay solver ───────────────────────
//
// The solver must record the (walletChainId, wallet) → (depositor, orderId,
// nonce) binding before the Hyperliquid sendAsset is broadcast; otherwise it
// won't recognize the incoming transfer as fulfilling this order.

const signedNonceMapping = signResult.signedTransactions[0].nonceMapping;
const authorizeBody = {
  type: "nonce-mapping",
  walletChainId: 1337,
  wallet: depositAddress,
  depositor: derivationFields.depositor,
  id: orderId,
  nonce: sweepNonce.toString(),
  // Deposit addresses are EOAs, so the EIP-712 domain chainId is arbitrary;
  // the Lit Action pins it to 1 (see src/derivation/vm/hyperliquid/signing.ts).
  signatureChainId: 1,
};
logSection("authorize nonce mapping (request)", authorizeBody);
logSection("authorize nonce mapping (signature)", signedNonceMapping.signature);
const authorizeRes = await fetch(
  `${solverUrl}/authorize?signature=${signedNonceMapping.signature}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(authorizeBody),
  },
);
const authorizeText = await authorizeRes.text();
if (!authorizeRes.ok) {
  throw new Error(`solver authorize failed (HTTP ${authorizeRes.status}): ${authorizeText}`);
}
let authorizeResp: unknown = authorizeText;
try {
  authorizeResp = JSON.parse(authorizeText);
} catch {
  /* keep raw text */
}
logSection("authorize nonce mapping (response)", authorizeResp);

// ─── 7. Submit signed sendAsset to Hyperliquid ──────────────────────────────

const sweepResp = await postExchange(
  {
    type: "sendAsset",
    ...sweepMsg,
    signatureChainId,
  },
  signResult.signedTransactions[0].sendAsset.signature as Hex,
);
logSection("hyperliquid /exchange response", sweepResp);

// ─── 8. Post-sweep balance ──────────────────────────────────────────────────

const finalBalance = await fetchDepositBalance(depositAddress);
console.log(
  `==> deposit address residual: ${formatUnits(finalBalance, currencyDecimals)} ${currencySymbol} (${finalBalance} base units)`,
);
console.log("✓ done");
