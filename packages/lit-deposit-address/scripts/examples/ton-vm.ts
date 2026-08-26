#!/usr/bin/env tsx
/**
 * Self-contained ton-vm deposit-address sweep (native TON only).
 *
 * Pipeline:
 *   1. Derive the deposit address (Lit Action `account` + `wallet`, plus an
 *      off-TEE parity check). The deposit wallet is a Wallet V5R1 contract.
 *   2. Fund the deposit address from `TON_VM_MNEMONIC` with
 *      `amount + gas buffer` and wait for the balance to arrive.
 *   3. Build a locally-signed order, then submit `trigger()` on the Base hub
 *      from `HUB_PRIVATE_KEY`.
 *   4. Request an oracle attestation.
 *   5. Build the Wallet V5R1 sweep (`to = depository`, `amount`, a text
 *      comment of `orderId|depositor=<addr>|`), feed it to the Lit Action's
 *      `sign` handler, then broadcast the returned external-message BOC.
 *
 * The oracle credits the deposit when this internal message lands on the
 * depository: native TON, non-bounceable, with the order id in the comment.
 *
 * Required env:
 *   LIT_ENV                environment name (e.g. dev)
 *   LIT_USAGE_API_KEY      Chipotle usage API key authorized for the action
 *   LIT_PKP_ID             PKP wallet address used by the action
 *   HUB_RPC_URL            Base hub RPC URL
 *   HUB_PRIVATE_KEY        EVM key that submits trigger() on the Base hub
 *   RELAY_ORACLE_URL       oracle base URL
 *   SOLVER_PRIVATE_KEY     EVM solver key used to authorize the order
 *   TON_VM_RPC_URL         toncenter v2 jsonRPC endpoint
 *   TON_VM_MNEMONIC        space-separated mnemonic for the funder wallet
 *                          (also the depositor + refund recipient)
 *   TON_VM_CHAIN_ID        Relay chain slug for TON (e.g. "ton")
 *   TON_VM_AMOUNT          deposit amount in whole TON (e.g. "0.05")
 *
 * Optional env:
 *   TON_VM_RPC_API_KEY     toncenter API key
 *   TON_VM_GAS_BUFFER      extra nanoton left on the deposit wallet for its
 *                          forward fee. Default: "50000000" (0.05 TON).
 */

import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { bytesToBigInt, parseUnits, type Address, type Hex } from "viem";
import {
  encodeAddress,
  getOrderId,
  getVmTypeNativeCurrency,
  type Order,
  type VmType as SdkVmType,
} from "@relay-protocol/settlement-sdk";
import { Address as TonAddress, Cell, internal, SendMode } from "@ton/core";
import { mnemonicToWalletKey } from "@ton/crypto";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
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
const rpcUrl = requireEnv("TON_VM_RPC_URL", "toncenter v2 jsonRPC endpoint");
const mnemonic = requireEnv("TON_VM_MNEMONIC", "space-separated funder mnemonic");
const chainSlug = requireEnv("TON_VM_CHAIN_ID", 'Relay chain slug for TON (e.g. "ton")');
const amountFloat = requireEnv("TON_VM_AMOUNT", 'deposit amount in whole TON (e.g. "0.05")');
const gasBuffer = BigInt(process.env.TON_VM_GAS_BUFFER?.trim() ?? "50000000");

const TON_DECIMALS = 9;
const amount = parseUnits(amountFloat, TON_DECIMALS);
if (amount <= 0n) {
  console.error(`TON_VM_AMOUNT must be > 0; got ${amountFloat}`);
  process.exit(1);
}

// ─── Wallets ────────────────────────────────────────────────────────────────

const client = new TonClient({
  endpoint: rpcUrl,
  apiKey: process.env.TON_VM_RPC_API_KEY?.trim(),
});
const funderKey = await mnemonicToWalletKey(mnemonic.split(/\s+/));
const funderWallet = WalletContractV5R1.create({ workchain: 0, publicKey: funderKey.publicKey });
const funder = client.open(funderWallet);

const hub = createHubClient(common);
const { solver, solverChainIdForOrder, solverVirtual } = createSolverContext(
  common.solverPrivateKey,
);

/** A workchain-0 TON address string → `0x`-prefixed 32-byte hash. */
function tonAddressToHex(address: string): string {
  return `0x${Buffer.from(encodeAddress(address, "ton-vm")).toString("hex")}`;
}

const funderAddress = funderWallet.address.toRawString();
const funderHex = tonAddressToHex(funderAddress);

// ─── Derivation fields + input ──────────────────────────────────────────────

const input = {
  vmType: "ton-vm" as const,
  chainId: chainSlug,
  currency: `0x${"00".repeat(32)}`, // native TON
  amount: amount.toString(),
};
const derivationFields: DerivationFields = {
  inputVmType: "ton-vm",
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

console.log(`==> funder / depositor / refund (ton): ${funderAddress}`);
console.log(`==> hub trigger submitter (evm):       ${hub.hubSigner.address}`);
console.log(`==> solver (evm):                      ${solver.address} (virtual ${solverVirtual})`);
console.log(`==> chain:                             ${chainSlug}`);
console.log(`==> amount:                            ${amountFloat} TON (${amount} nanoton)`);
console.log();

// ─── 1. Derive deposit address ──────────────────────────────────────────────

const litClient: DepositAddressesClient = {
  apiBaseUrl: DEFAULT_BASE_URL,
  apiKey: common.usageApiKey,
  pkpId: common.pkpId,
  envName: common.envName,
  vmType: "ton-vm",
};

const account = (await executeLitAction(litClient, {
  action: "account",
  vmType: "ton-vm",
})) as AccountResponse;
const remoteWallet = (await executeLitAction(litClient, {
  action: "wallet",
  derivationFields,
})) as LocalWalletInfo;
const localWallet = await deriveDepositWallet(account, derivationFields);
if (remoteWallet.address !== localWallet.address) {
  console.error(
    `✗ deposit address mismatch: action=${remoteWallet.address}, local=${localWallet.address}`,
  );
  process.exit(1);
}
const depositAddress = TonAddress.parseRaw(remoteWallet.address);
console.log(`==> deposit address: ${depositAddress.toRawString()}`);
console.log(`==> deposit address (friendly): ${depositAddress.toString({ bounceable: false })}`);
console.log();

// ─── 2. Fund the deposit address ────────────────────────────────────────────

const required = amount + gasBuffer;
const balance = await client.getBalance(depositAddress);
if (balance < required) {
  const fundingAmount = required - balance;
  console.log(
    `==> funding ${depositAddress.toRawString()} with ${fundingAmount} nanoton (balance=${balance}, required=${required})`,
  );
  const seqno = await funder.getSeqno();
  await funder.sendTransfer({
    secretKey: funderKey.secretKey,
    seqno,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: depositAddress,
        value: fundingAmount,
        bounce: false,
        body: "deposit funding",
      }),
    ],
  });
  // Wait for the deposit wallet balance to reflect the transfer.
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    if ((await client.getBalance(depositAddress)) >= required) {
      break;
    }
  }
}
console.log(`==> deposit wallet balance: ${await client.getBalance(depositAddress)} nanoton`);
console.log();

// ─── 3. Build order + submit trigger ────────────────────────────────────────

const nativeCurrency = getVmTypeNativeCurrency("ton-vm");
const currencies = [
  { chainId: chainSlug, currency: input.currency as Hex },
  { chainId: derivationFields.outputChainId, currency: derivationFields.outputCurrency as Hex },
] as const;
const prices = currencies.map(() => placeholderPrice(TON_DECIMALS));
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
        currency: nativeCurrency,
        amount: amount.toString(),
        weight: "1",
      },
      refunds: [
        {
          chainId: chainSlug,
          recipient: funderAddress,
          currency: nativeCurrency,
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
const chainsConfig: Record<string, SdkVmType> = buildChainsConfig(chainSlug, "ton-vm");
const orderId = getOrderId(order, chainsConfig) as Hex;
const orderSignature = await solver.signMessage({ message: { raw: orderId } });

/** Mirror the SDK's `normalizeOrder` so the action sees bytes-hex fields. */
function encodeAddressForChain(addr: string, chainId: string): string {
  const vm = chainsConfig[chainId];
  if (!vm) {
    throw new Error(`unknown chainId in order normalization: ${chainId}`);
  }
  return `0x${Buffer.from(encodeAddress(addr, vm)).toString("hex")}`;
}
function normalizeOrderForAction(o: Order): Order {
  return {
    ...o,
    inputs: o.inputs.map((inp) => ({
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
      ...o.output,
      payments: o.output.payments.map((p) => ({
        ...p,
        recipient: encodeAddressForChain(p.recipient, o.output.chainId),
        currency: encodeAddressForChain(p.currency, o.output.chainId),
      })),
    },
  };
}
const normalizedOrder = normalizeOrderForAction(order);

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

// ─── 5. Build the sweep + sign ──────────────────────────────────────────────

// The depository's `inputDepository` is a 32-byte basechain account hash.
const depository = new TonAddress(0, Buffer.from(attestation.inputDepository.slice(2), "hex"));
const comment = `${orderId}|depositor=${funderAddress}|`;
const depositSeqno = await getDepositSeqno();

const transaction = {
  to: depository.toRawString(),
  amount: amount.toString(),
  comment,
  bounce: false,
  seqno: depositSeqno,
  validUntil: Math.floor(Date.now() / 1000) + 600,
  // PAY_GAS_SEPARATELY (1) | IGNORE_ERRORS (2): deliver exactly `amount`,
  // forward fee comes out of the wallet's remaining balance.
  sendMode: 3,
};

logSection("ton sweep", {
  from: depositAddress.toRawString(),
  to: depository.toRawString(),
  amount: amount.toString(),
  seqno: depositSeqno,
  comment,
});

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
    transactions: [transaction],
  },
  solver,
);
const signResult = (await executeLitAction(litClient, signRequest)) as {
  wallet: LocalWalletInfo;
  triggerHash: string;
  signedTransactions: Array<{ signature: string; signingHash: string; externalMessage: string }>;
};
logSection("lit action sign response", signResult);

// ─── 6. Broadcast ──────────────────────────────────────────────────────────

const externalMessage = Buffer.from(signResult.signedTransactions[0].externalMessage, "base64");
const externalMessageHash = Cell.fromBoc(externalMessage)[0].hash().toString("hex");
await client.sendFile(externalMessage);
console.log(`==> broadcast external message (${externalMessage.length} bytes)`);
console.log(`==> external message hash (track on tonviewer): ${externalMessageHash}`);
console.log();

// ─── 7. Detect the on-chain deposit transaction ─────────────────────────────
//
// A TON deposit is the internal message that lands on the *depository*
// account (external-in → deposit wallet → internal-in → depository). TON has
// no global tx-hash index, so the Relay oracle's deposit endpoint needs both
// the depository transaction hash (`transactionId`) and its logical time as a
// `ton-vm.lt` hint. Poll the depository for the tx whose inbound message came
// from our deposit wallet and carries this order id in its comment.
const deposit = await waitForDepositTransaction();
if (deposit) {
  logSection("detected deposit transaction (pass these to the oracle)", {
    transactionId: deposit.hash,
    "hints.ton-vm.lt": deposit.lt,
  });
  console.log("✓ done");
} else {
  console.log(
    `✗ deposit not yet visible on depository ${depository.toRawString()}; retry the lookup later`,
  );
}

/** Current seqno of the deposit wallet (0 when not yet deployed). */
async function getDepositSeqno(): Promise<number> {
  const state = await client.getContractState(depositAddress);
  if (state.state !== "active") {
    return 0;
  }
  const res = await client.runMethod(depositAddress, "seqno");
  return res.stack.readNumber();
}

/** Decode a TON text-comment (opcode 0) body, or undefined for other bodies. */
function decodeComment(body: Cell): string | undefined {
  try {
    const slice = body.beginParse();
    if (slice.remainingBits < 32 || slice.loadUint(32) !== 0) {
      return undefined;
    }
    return slice.loadStringTail();
  } catch {
    return undefined;
  }
}

/**
 * Poll the depository account for the deposit: the transaction whose inbound
 * internal message comes from our deposit wallet and whose comment starts with
 * this order id. Returns its tx hash (hex) + logical time, which together
 * identify the transaction for the oracle.
 */
async function waitForDepositTransaction(): Promise<{ hash: string; lt: string } | undefined> {
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(3000);
    const txs = await client.getTransactions(depository, { limit: 25, archival: true });
    for (const tx of txs) {
      const inMsg = tx.inMessage;
      if (!inMsg || inMsg.info.type !== "internal") {
        continue;
      }
      if (!inMsg.info.src.equals(depositAddress)) {
        continue;
      }
      const comment = decodeComment(inMsg.body);
      if (comment?.startsWith(orderId)) {
        return { hash: tx.hash().toString("hex"), lt: tx.lt.toString() };
      }
    }
  }
  return undefined;
}
