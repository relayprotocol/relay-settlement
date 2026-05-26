#!/usr/bin/env tsx
/**
 * Self-contained ethereum-vm deposit-address sweep.
 *
 * Pipeline:
 *   1. Derive the deposit address (Lit Action `account` + `wallet`, plus
 *      off-TEE parity check).
 *   2. Fund the deposit address from `PRIVATE_KEY`:
 *        - native: a single ETH transfer of `amount + gas buffer`.
 *        - ERC-20: an `ERC20.transfer(deposit, amount)` followed by an ETH
 *          transfer for gas.
 *   3. Build a locally-signed order pinning depositor / refundRecipient to
 *      the funder address, then submit `trigger()` on the Base hub.
 *   4. Request an oracle attestation for that trigger.
 *   5. Build the unsigned deposit tx(s) (`depositNative` or
 *      `approve + depositErc20`), have the Lit Action sign them inside the
 *      TEE, and broadcast on the source chain.
 *
 * Required env:
 *   LIT_ENV                   environment name (e.g. dev)
 *   LIT_USAGE_API_KEY         Chipotle usage API key authorized for the action
 *   LIT_PKP_ID                PKP wallet address used by the action
 *   HUB_RPC_URL               Base hub RPC URL
 *   HUB_PRIVATE_KEY           wallet that submits trigger() on the Base hub.
 *                             Only needs Base ETH for the trigger gas.
 *   ETHEREUM_VM_RPC_URL       source-chain RPC URL.
 *   ETHEREUM_VM_PRIVATE_KEY   funder + depositor + refund recipient on the
 *                             source chain. Holds the currency to be
 *                             deposited plus enough native gas.
 *   ETHEREUM_VM_CHAIN_ID      source chain slug (e.g. "optimism") or
 *                             numeric id ("10").
 *   ETHEREUM_VM_CURRENCY      0x0… for native ETH (treated as ETH), or an
 *                             ERC-20 contract address.
 *   ETHEREUM_VM_CURRENCY_DECIMALS
 *                             decimals to parse ETHEREUM_VM_AMOUNT with
 *                             (e.g. "18" for ETH, "6" for USDC).
 *   ETHEREUM_VM_AMOUNT        deposit amount as a decimal string in whole
 *                             units (e.g. "0.0001").
 *   SOLVER_PRIVATE_KEY        solver key; pin across runs to keep the
 *                             deposit address stable.
 *
 *   RELAY_ORACLE_URL          oracle base URL.
 *
 * Optional env:
 *   FUNDING_GAS_BUFFER        multiplier for the gas allowance the funder
 *                             sends to the deposit wallet. Default: "2".
 */

import { randomBytes } from "node:crypto";
import {
  bytesToBigInt,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getContract,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getOrderId, type Order } from "@relay-protocol/settlement-sdk";
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
const sourceRpcUrl = requireEnv("ETHEREUM_VM_RPC_URL", "source-chain RPC URL");
const privateKey = requireEnv(
  "ETHEREUM_VM_PRIVATE_KEY",
  "funder + depositor + refund recipient key on the source chain (0x-prefixed)",
) as Hex;
const chainSlug = requireEnv(
  "ETHEREUM_VM_CHAIN_ID",
  'source chain slug (e.g. "optimism") or numeric id ("10")',
);
function normalizeEvmAddress(addr: string, field: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    console.error(`${field} must be a 0x-prefixed 20-byte hex address; got: ${addr}`);
    process.exit(1);
  }
  // EVM addresses are canonicalised to lowercase before they go into the
  // trigger / derivation-fields `bytes` payloads so the on-chain hash and
  // the off-TEE wallet derivation agree byte-for-byte. abi-encoded `bytes`
  // is sensitive to the raw byte content; the hex string "0xAbCd..." and
  // "0xabcd..." decode to the same bytes, but downstream consumers compare
  // the encoded hex string itself (e.g. `derivationFields.depositor`
  // matched against the depositNative call arg) and would diverge on case.
  return addr.toLowerCase() as Address;
}
const currency = normalizeEvmAddress(
  requireEnv("ETHEREUM_VM_CURRENCY", "0x0\u2026 for native ETH, or an ERC-20 contract address"),
  "ETHEREUM_VM_CURRENCY",
);
const currencyDecimalsStr = requireEnv(
  "ETHEREUM_VM_CURRENCY_DECIMALS",
  "decimals to parse ETHEREUM_VM_AMOUNT (e.g. 18 for ETH, 6 for USDC)",
);
const currencyDecimals = Number.parseInt(currencyDecimalsStr, 10);
if (!Number.isInteger(currencyDecimals) || currencyDecimals < 0 || currencyDecimals > 36) {
  console.error(
    `ETHEREUM_VM_CURRENCY_DECIMALS must be an integer in [0, 36]; got ${currencyDecimalsStr}`,
  );
  process.exit(1);
}
const amountFloat = requireEnv(
  "ETHEREUM_VM_AMOUNT",
  'deposit amount as a decimal string in whole units (e.g. "0.0001")',
);
let amount: bigint;
try {
  amount = parseUnits(amountFloat, currencyDecimals);
} catch (e) {
  console.error(
    `ETHEREUM_VM_AMOUNT must parse as a decimal with ${currencyDecimals} decimals; got ${amountFloat} (${
      e instanceof Error ? e.message : e
    })`,
  );
  process.exit(1);
}
if (amount <= 0n) {
  console.error(`ETHEREUM_VM_AMOUNT must be > 0; got ${amountFloat}`);
  process.exit(1);
}
const fundingGasBuffer = BigInt(process.env.FUNDING_GAS_BUFFER?.trim() ?? "2");

const isNative = BigInt(currency) === 0n;

const SLUG_TO_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  optimism: 10,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
};
function slugToNumericChainId(slug: string): number {
  if (/^\d+$/.test(slug)) {
    return Number(slug);
  }
  const id = SLUG_TO_CHAIN_ID[slug.toLowerCase()];
  if (id === undefined) {
    throw new Error(
      `unknown CHAIN_ID slug: ${slug} — add it to SLUG_TO_CHAIN_ID or pass the numeric id`,
    );
  }
  return id;
}
const sourceChainNumericId = slugToNumericChainId(chainSlug);

// ─── Wallets ────────────────────────────────────────────────────────────────

const funder = privateKeyToAccount(privateKey);
const sourceTransport = http(sourceRpcUrl);
const sourceClient = createPublicClient({ transport: sourceTransport });
const sourceWallet: WalletClient = createWalletClient({
  account: funder,
  transport: sourceTransport,
});
const hub = createHubClient(common);
const { solver, solverChainIdForOrder, solverVirtual } = createSolverContext(
  common.solverPrivateKey,
);

// ─── Derivation fields + input ──────────────────────────────────────────────

const input = {
  vmType: "ethereum-vm" as const,
  chainId: chainSlug,
  currency,
  amount: amount.toString(),
};
const derivationFields: DerivationFields = {
  inputVmType: "ethereum-vm",
  outputVmType: "ethereum-vm",
  outputChainId: "base",
  outputCurrency: "0x0000000000000000000000000000000000000000",
  outputRecipient: funder.address.toLowerCase(),
  solver: solverVirtual,
  pricingOracle: "0xaf0e1fe8897d2f14209aa8330953917f89f278a2",
  depositor: funder.address.toLowerCase(),
  refundRecipient: funder.address.toLowerCase(),
  priceImpactBps: "200",
};

console.log(`==> funder / depositor / refund: ${funder.address}`);
console.log(`==> hub trigger submitter:      ${hub.hubSigner.address}`);
console.log(`==> solver: ${solver.address} (virtual: ${solverVirtual})`);
console.log(`==> chain:  ${chainSlug} (numeric=${sourceChainNumericId})`);
console.log(
  `==> currency: ${currency}${isNative ? " (native ETH)" : " (ERC-20)"} (decimals=${currencyDecimals})`,
);
console.log(`==> amount: ${amountFloat} (${amount} base units)`);
console.log();

// ─── 1. Derive deposit address ──────────────────────────────────────────────

const client: DepositAddressesClient = {
  apiBaseUrl: DEFAULT_BASE_URL,
  apiKey: common.usageApiKey,
  pkpId: common.pkpId,
  envName: common.envName,
  vmType: "ethereum-vm",
};

const account = (await executeLitAction(client, {
  action: "account",
  vmType: "ethereum-vm",
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
const depositAddress = remoteWallet.address as Address;
console.log(`==> deposit address: ${depositAddress}`);
console.log();

// ─── 2. Fund the deposit address ────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const fees = await sourceClient.estimateFeesPerGas();

async function fundDeposit(): Promise<void> {
  if (isNative) {
    // Need to cover input.amount (sent in depositNative) AND the gas the
    // deposit wallet will spend on that single transaction.
    const gasLimit = 100_000n; // depositNative is ~50k; double for headroom.
    const required = amount + gasLimit * fees.maxFeePerGas * fundingGasBuffer;
    const balance = await sourceClient.getBalance({ address: depositAddress });
    if (balance >= required) {
      console.log(
        `==> skipping native funding: ${depositAddress} balance (${balance}) >= required (${required})`,
      );
      return;
    }
    const fundingAmount = required - balance;
    console.log(
      `==> native funding ${depositAddress} with ${fundingAmount} wei (balance=${balance}, required=${required})`,
    );
    const hash = await sourceWallet.sendTransaction({
      to: depositAddress,
      value: fundingAmount,
      account: funder,
      chain: null,
    });
    const receipt = await sourceClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`funding tx reverted: ${hash}`);
    }
    console.log(`==> funded: ${hash}`);
    return;
  }

  // ERC-20 deposit uses two txs (approve + depositErc20), allow generous gas.
  const gasLimit = 250_000n;
  const requiredGas = gasLimit * fees.maxFeePerGas * fundingGasBuffer;
  const [tokenBalance, nativeBalance] = await Promise.all([
    sourceClient.readContract({
      address: currency,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [depositAddress],
    }) as Promise<bigint>,
    sourceClient.getBalance({ address: depositAddress }),
  ]);

  // Token leg.
  if (tokenBalance >= amount) {
    console.log(
      `==> skipping erc-20 transfer: ${depositAddress} token balance (${tokenBalance}) >= amount (${amount})`,
    );
  } else {
    const tokenShortfall = amount - tokenBalance;
    console.log(
      `==> erc-20 funding ${depositAddress} with ${tokenShortfall} of ${currency} (balance=${tokenBalance}, amount=${amount})`,
    );
    const transferHash = await sourceWallet.writeContract({
      address: currency,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [depositAddress, tokenShortfall],
      account: funder,
      chain: null,
    });
    const transferReceipt = await sourceClient.waitForTransactionReceipt({ hash: transferHash });
    if (transferReceipt.status !== "success") {
      throw new Error(`ERC20.transfer tx reverted: ${transferHash}`);
    }
    console.log(`==> token transfer: ${transferHash}`);
  }

  // Native gas leg.
  if (nativeBalance >= requiredGas) {
    console.log(
      `==> skipping native gas funding: ${depositAddress} balance (${nativeBalance}) >= required (${requiredGas})`,
    );
    return;
  }
  const gasFunding = requiredGas - nativeBalance;
  console.log(
    `==> native gas funding ${depositAddress} with ${gasFunding} wei (balance=${nativeBalance}, required=${requiredGas})`,
  );
  const gasHash = await sourceWallet.sendTransaction({
    to: depositAddress,
    value: gasFunding,
    account: funder,
    chain: null,
  });
  const gasReceipt = await sourceClient.waitForTransactionReceipt({ hash: gasHash });
  if (gasReceipt.status !== "success") {
    throw new Error(`gas funding tx reverted: ${gasHash}`);
  }
  console.log(`==> gas funded: ${gasHash}`);
}

await fundDeposit();
console.log();

// ─── 3. Build order + submit trigger ────────────────────────────────────────

const currencies = [
  { chainId: chainSlug, currency: currency as Hex },
  { chainId: derivationFields.outputChainId, currency: derivationFields.outputCurrency as Hex },
] as const;
const prices = currencies.map(() => placeholderPrice(currencyDecimals));
const extraData = encodePricesExtraData(prices);
const nonce = bytesToBigInt(randomBytes(32));

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
        currency,
        amount: amount.toString(),
        weight: "1",
      },
      refunds: [
        {
          chainId: chainSlug,
          recipient: funder.address.toLowerCase(),
          currency,
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

const orderId = getOrderId(order, buildChainsConfig(chainSlug, "ethereum-vm")) as Hex;
const orderSignature = await solver.signMessage({ message: { raw: orderId } });

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
  },
  orderId,
  nonce,
  currencies,
  extraData,
});

// ─── 4. Oracle attestation ──────────────────────────────────────────────────

const attestation = await requestAttestation(common.oracleUrl, {
  input,
  derivationFields: derivationFields as unknown as Record<string, unknown>,
  orderId,
  nonce,
  currencies,
  prices,
  extraData,
});

// ─── 5. Build deposit tx(s) ─────────────────────────────────────────────────

const DEPOSIT_NATIVE_ABI = parseAbi(["function depositNative(address depositor, bytes32 orderId)"]);
const DEPOSIT_ERC20_ABI = parseAbi([
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 orderId)",
]);
const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
]);

interface UnsignedTx {
  unsignedTransaction: Hex;
}

async function buildUnsignedTransactions(): Promise<UnsignedTx[]> {
  const inputDepository = attestation.inputDepository as Address;
  const startNonce = await sourceClient.getTransactionCount({ address: depositAddress });
  const { serializeTransaction } = await import("viem");
  if (isNative) {
    const data = encodeFunctionData({
      abi: DEPOSIT_NATIVE_ABI,
      functionName: "depositNative",
      args: [funder.address as Address, orderId],
    });
    const gas = await sourceClient.estimateGas({
      account: depositAddress,
      to: inputDepository,
      value: amount,
      data,
    });
    return [
      {
        unsignedTransaction: serializeTransaction({
          type: "eip1559",
          to: inputDepository,
          value: amount,
          data,
          nonce: startNonce,
          gas,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          chainId: sourceChainNumericId,
        }),
      },
    ];
  }

  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [inputDepository, amount],
  });
  const depositData = encodeFunctionData({
    abi: DEPOSIT_ERC20_ABI,
    functionName: "depositErc20",
    args: [funder.address as Address, currency, amount, orderId],
  });
  // Pick gas limits high enough for both txs; estimate fails because the
  // deposit wallet hasn't run `approve` yet, so we hardcode safe ceilings.
  const approveGas = 80_000n;
  const depositGas = 200_000n;
  return [
    {
      unsignedTransaction: serializeTransaction({
        type: "eip1559",
        to: currency,
        value: 0n,
        data: approveData,
        nonce: startNonce,
        gas: approveGas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        chainId: sourceChainNumericId,
      }),
    },
    {
      unsignedTransaction: serializeTransaction({
        type: "eip1559",
        to: inputDepository,
        value: 0n,
        data: depositData,
        nonce: startNonce + 1,
        gas: depositGas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        chainId: sourceChainNumericId,
      }),
    },
  ];
}

const transactions = await buildUnsignedTransactions();
logSection("unsigned transactions", transactions);

// ─── 6. Lit Action sign ────────────────────────────────────────────────────

const signRequest = await addSolverRequestSignature(
  {
    pkpId: common.pkpId,
    action: "sign",
    trigger: {
      input,
      derivationFields,
      orderId,
      nonce: nonce.toString(),
      currencies,
      prices: prices.map((p) => ({
        usdPrice: p.usdPrice.toString(),
        usdPriceDecimals: p.usdPriceDecimals,
        currencyDecimals: p.currencyDecimals,
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
    order: order as unknown as Record<string, unknown>,
    orderSignature,
    transactions,
  },
  solver,
);
const signResult = (await executeLitAction(client, signRequest)) as {
  wallet: LocalWalletInfo;
  triggerHash: string;
  signedTransactions: Array<{ rawTransaction: Hex; transactionHash: Hex }>;
};
logSection("lit action sign response", signResult);

// ─── 7. Broadcast signed txs ───────────────────────────────────────────────

for (let i = 0; i < signResult.signedTransactions.length; i++) {
  const { rawTransaction } = signResult.signedTransactions[i];
  const hash = await sourceClient.sendRawTransaction({ serializedTransaction: rawTransaction });
  console.log(`==> broadcast tx[${i}]: ${hash}`);
  const receipt = await sourceClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error(`✗ tx[${i}] reverted: ${hash}`);
    process.exit(1);
  }
  console.log(`✓ tx[${i}] mined: ${hash}`);
}

// ─── 8. Final balances ─────────────────────────────────────────────────────

if (isNative) {
  const depositBalance = await sourceClient.getBalance({ address: depositAddress });
  console.log();
  console.log(
    `==> deposit address residual balance: ${formatUnits(depositBalance, currencyDecimals)} ETH (${depositBalance} wei)`,
  );
} else {
  const token = getContract({
    address: currency,
    abi: ERC20_ABI,
    client: sourceClient,
  });
  const [depositBalance, depositNative] = await Promise.all([
    token.read.balanceOf([depositAddress]) as Promise<bigint>,
    sourceClient.getBalance({ address: depositAddress }),
  ]);
  console.log();
  console.log(
    `==> deposit address residual: ${formatUnits(depositBalance, currencyDecimals)} ${currency} (${depositBalance} base units) + ${depositNative} wei native gas`,
  );
}
console.log("✓ done");
