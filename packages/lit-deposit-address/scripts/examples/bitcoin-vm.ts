#!/usr/bin/env tsx
/**
 * Self-contained bitcoin-vm deposit-address sweep (native BTC).
 *
 * Pipeline:
 *   1. Derive the deposit address (Lit Action `account` + local derivation
 *      parity check). The deposit wallet is a native-segwit P2WPKH `bc1q...`.
 *   2. Fund the deposit address from `BITCOIN_VM_PRIVATE_KEY` over the
 *      configured mempool-style HTTP API (UTXO query + raw tx broadcast).
 *   3. Build a locally-signed Relay order pinning depositor/refundRecipient
 *      to the funder's P2WPKH address, then submit `trigger()` on the Base
 *      hub from `HUB_PRIVATE_KEY`.
 *   4. Request an oracle attestation for that trigger.
 *   5. Construct the unsigned BTC deposit transaction:
 *        - one (or more) P2WPKH inputs from the deposit address,
 *        - one output paying `attestation.inputDepository` the deposit amount,
 *        - one OP_RETURN output carrying `<orderId>|depositor=<address>|`,
 *        - one change output paying the refund recipient.
 *      Compute the BIP143 segwit SIGHASH_ALL digest per input and pass them
 *      to the Lit Action `sign` handler.
 *   6. Compose the final witness transaction from the action-returned
 *      compact signatures + the deposit wallet pubkey, then broadcast.
 *
 * Required env:
 *   LIT_ENV                       environment name (e.g. dev)
 *   LIT_USAGE_API_KEY             Chipotle usage API key authorized for the action
 *   LIT_PKP_ID                    PKP wallet address used by the action
 *   HUB_RPC_URL                   Base hub RPC URL
 *   HUB_PRIVATE_KEY               EVM key that submits trigger() on the
 *                                 Base hub. Only needs Base ETH for the
 *                                 trigger gas.
 *   BITCOIN_VM_API_URL            mempool.space-style REST API base URL
 *                                 (e.g. https://mempool.space/api for
 *                                 mainnet, https://mempool.space/testnet/api
 *                                 for testnet, or any Esplora-compatible
 *                                 mirror).
 *   BITCOIN_VM_PRIVATE_KEY        32-byte hex secp256k1 private key
 *                                 (0x-prefixed). The derived P2WPKH address
 *                                 acts as the funder, depositor, and refund
 *                                 recipient.
 *   BITCOIN_VM_CHAIN_ID           Relay chain slug for Bitcoin (e.g.
 *                                 "bitcoin").
 *   BITCOIN_VM_AMOUNT             deposit amount as a decimal BTC string
 *                                 (e.g. "0.0001"). Parsed with 8 decimals.
 *   SOLVER_PRIVATE_KEY            EVM solver key used to authorize the order.
 *
 *   RELAY_ORACLE_URL              oracle base URL.
 *
 * Optional env:
 *   BITCOIN_VM_FEE_SAT_PER_VBYTE  fee rate in sat/vB used for both the
 *                                 funding and deposit transactions. Default:
 *                                 fetched from the mempool API's
 *                                 `/v1/fees/recommended` (`halfHourFee`).
 *   BITCOIN_VM_DEPOSIT_FEE_SAT    explicit fee in satoshis for the deposit
 *                                 transaction. Overrides the rate-based
 *                                 estimate. Useful when the OP_RETURN size
 *                                 makes vsize estimation unreliable.
 */

import { randomBytes } from "node:crypto";
import { bytesToBigInt, parseUnits, type Address, type Hex } from "viem";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeAddress, getOrderId, type Order } from "@relay-protocol/settlement-sdk";
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
const apiUrl = requireEnv("BITCOIN_VM_API_URL", "mempool.space-style REST API base URL").replace(
  /\/+$/,
  "",
);
const funderPrivateKeyHex = requireEnv(
  "BITCOIN_VM_PRIVATE_KEY",
  "32-byte hex secp256k1 private key (0x-prefixed)",
);
const chainSlug = requireEnv(
  "BITCOIN_VM_CHAIN_ID",
  'Relay chain slug for Bitcoin (e.g. "bitcoin")',
);
const amountFloat = requireEnv(
  "BITCOIN_VM_AMOUNT",
  'deposit amount as a decimal BTC string (e.g. "0.0001")',
);
const explicitDepositFeeSat = process.env.BITCOIN_VM_DEPOSIT_FEE_SAT?.trim();
const explicitFeeRate = process.env.BITCOIN_VM_FEE_SAT_PER_VBYTE?.trim();

const BTC_DECIMALS = 8;
const amount = parseUnits(amountFloat, BTC_DECIMALS);
if (amount <= 0n) {
  console.error(`BITCOIN_VM_AMOUNT must be > 0; got ${amountFloat}`);
  process.exit(1);
}

if (!/^0x[0-9a-fA-F]{64}$/.test(funderPrivateKeyHex)) {
  console.error("BITCOIN_VM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  process.exit(1);
}

// ─── Bitcoin primitives (inline; see src/derivation/vm/bitcoin/transaction.ts) ─

const SIGHASH_ALL = 0x01;
const OP_RETURN = 0x6a;

function hexToBytes(value: string): Uint8Array {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(value: Uint8Array): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    out += value[i].toString(16).padStart(2, "0");
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((acc, p) => acc + p.length, 0));
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++, n >>= 8n) {
    out[i] = Number(n & 0xffn);
  }
  return out;
}

function varInt(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0xfdn) {
    return new Uint8Array([Number(v)]);
  }
  if (v <= 0xffffn) {
    return new Uint8Array([0xfd, Number(v & 0xffn), Number((v >> 8n) & 0xffn)]);
  }
  if (v <= 0xffff_ffffn) {
    return concat([new Uint8Array([0xfe]), u32le(Number(v))]);
  }
  return concat([new Uint8Array([0xff]), u64le(v)]);
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function hash256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function p2wpkhCode(pubkey: Uint8Array): Uint8Array {
  return concat([
    new Uint8Array([0x76, 0xa9, 0x14]),
    hash160(pubkey),
    new Uint8Array([0x88, 0xac]),
  ]);
}

/**
 * Encode a bech32 native-segwit (v0/v1+) address into its output script. The
 * Relay SDK encodes any bech32 address as `[version, ...program]`; we mirror
 * the policy decoder so the produced output matches what the Lit Action
 * verifier expects for `attestation.inputDepository`.
 */
function bech32AddressToScript(address: string): Uint8Array {
  const decoded = bech32.decode(address.toLowerCase() as `${string}1${string}`, 90);
  const version = decoded.words[0];
  const program = bech32.fromWords(decoded.words.slice(1));
  if (version < 0 || version > 16) {
    throw new Error(`unsupported bech32 witness version: ${version}`);
  }
  const versionOp = version === 0 ? 0x00 : 0x50 + version;
  return concat([new Uint8Array([versionOp, program.length]), Uint8Array.from(program)]);
}

interface UnsignedInput {
  txid: Uint8Array; // 32-byte big-endian as fetched from the API; serialized little-endian on the wire
  vout: number;
  valueSat: bigint;
}

interface UnsignedOutput {
  valueSat: bigint;
  script: Uint8Array;
}

/**
 * Serialize an unsigned segwit transaction with empty witness data (matching
 * the shape the action's verifier accepts).
 */
function serializeUnsigned(inputs: UnsignedInput[], outputs: UnsignedOutput[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(u32le(2)); // version
  parts.push(new Uint8Array([0x00, 0x01])); // marker + flag (segwit)
  parts.push(varInt(inputs.length));
  for (const inp of inputs) {
    // Outpoint txid is little-endian on the wire; mempool returns big-endian.
    const txidLe = new Uint8Array(inp.txid).reverse();
    parts.push(txidLe);
    parts.push(u32le(inp.vout));
    parts.push(new Uint8Array([0x00])); // empty scriptSig
    parts.push(u32le(0xffffffff)); // sequence
  }
  parts.push(varInt(outputs.length));
  for (const out of outputs) {
    parts.push(u64le(out.valueSat));
    parts.push(varInt(out.script.length));
    parts.push(out.script);
  }
  // Empty witness stack per input (action requires unsigned segwit txs to
  // carry empty witnesses).
  for (let i = 0; i < inputs.length; i++) {
    parts.push(new Uint8Array([0x00]));
  }
  parts.push(u32le(0)); // locktime
  return concat(parts);
}

/** Per-input BIP143 SIGHASH_ALL digest. */
function sighash(
  inputs: UnsignedInput[],
  outputs: UnsignedOutput[],
  inputIndex: number,
  pubkey: Uint8Array,
): Uint8Array {
  const version = u32le(2);
  const locktime = u32le(0);
  const sequence = u32le(0xffffffff);
  const outpoints = concat(
    inputs.map((i) => concat([new Uint8Array(i.txid).reverse(), u32le(i.vout)])),
  );
  const sequences = concat(inputs.map(() => sequence));
  const outputBytes = concat(
    outputs.map((o) => concat([u64le(o.valueSat), varInt(o.script.length), o.script])),
  );
  const input = inputs[inputIndex];
  return hash256(
    concat([
      version,
      hash256(outpoints),
      hash256(sequences),
      new Uint8Array(input.txid).reverse(),
      u32le(input.vout),
      varInt(p2wpkhCode(pubkey).length),
      p2wpkhCode(pubkey),
      u64le(input.valueSat),
      sequence,
      hash256(outputBytes),
      locktime,
      u32le(SIGHASH_ALL),
    ]),
  );
}

/**
 * Encode a compact 64-byte ECDSA signature (r || s) as DER, then append the
 * SIGHASH_ALL flag. Bitcoin policy enforces low-S; @noble/curves returns
 * canonical low-S signatures by default.
 */
function compactToDerSig(compact: Uint8Array): Uint8Array {
  if (compact.length !== 64) {
    throw new Error(`expected 64-byte compact signature, got ${compact.length}`);
  }
  const trim = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && (b[i + 1] & 0x80) === 0) {
      i++;
    }
    const out = b.slice(i);
    return (out[0] & 0x80) !== 0 ? concat([new Uint8Array([0x00]), out]) : out;
  };
  const r = trim(compact.slice(0, 32));
  const s = trim(compact.slice(32, 64));
  const der = concat([
    new Uint8Array([0x30, 2 + r.length + 2 + s.length, 0x02, r.length]),
    r,
    new Uint8Array([0x02, s.length]),
    s,
  ]);
  return concat([der, new Uint8Array([SIGHASH_ALL])]);
}

/**
 * Compose the final witness transaction by appending each input's witness
 * stack (`[der_sig + sighash_flag, pubkey]`) to the unsigned tx layout.
 */
function composeWitnessTx(
  inputs: UnsignedInput[],
  outputs: UnsignedOutput[],
  signatures: Uint8Array[], // compact 64-byte ECDSA signatures, one per input
  pubkey: Uint8Array,
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(u32le(2));
  parts.push(new Uint8Array([0x00, 0x01]));
  parts.push(varInt(inputs.length));
  for (const inp of inputs) {
    parts.push(new Uint8Array(inp.txid).reverse());
    parts.push(u32le(inp.vout));
    parts.push(new Uint8Array([0x00]));
    parts.push(u32le(0xffffffff));
  }
  parts.push(varInt(outputs.length));
  for (const out of outputs) {
    parts.push(u64le(out.valueSat));
    parts.push(varInt(out.script.length));
    parts.push(out.script);
  }
  for (let i = 0; i < inputs.length; i++) {
    const der = compactToDerSig(signatures[i]);
    parts.push(new Uint8Array([0x02])); // witness stack item count
    parts.push(varInt(der.length));
    parts.push(der);
    parts.push(varInt(pubkey.length));
    parts.push(pubkey);
  }
  parts.push(u32le(0));
  return concat(parts);
}

// ─── Funder wallet ──────────────────────────────────────────────────────────

const funderPrivateKey = hexToBytes(funderPrivateKeyHex);
const funderPublicKey = secp256k1.getPublicKey(funderPrivateKey, true);
const funderProgram = hash160(funderPublicKey);
const funderAddress = bech32.encode("bc", [0, ...bech32.toWords(funderProgram)]);
// The Relay SDK normalizes bitcoin-vm addresses through its codec; the
// resulting bytes-hex is what we pass into derivation fields/order.
function encodeBtcAddressHex(addr: string): string {
  return `0x${bytesToHex(encodeAddress(addr, "bitcoin-vm"))}`;
}
const funderEncoded = encodeBtcAddressHex(funderAddress).toLowerCase();

const hub = createHubClient(common);
const { solver, solverChainIdForOrder, solverVirtual } = createSolverContext(
  common.solverPrivateKey,
);

// ─── Derivation fields + input ──────────────────────────────────────────────

const BTC_NATIVE_CURRENCY = encodeBtcAddressHex(
  "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8",
).toLowerCase();

const input = {
  vmType: "bitcoin-vm" as const,
  chainId: chainSlug,
  currency: BTC_NATIVE_CURRENCY,
  amount: amount.toString(),
};
const derivationFields: DerivationFields = {
  inputVmType: "bitcoin-vm",
  outputVmType: "ethereum-vm",
  outputChainId: "base",
  outputCurrency: "0x0000000000000000000000000000000000000000",
  outputRecipient: hub.hubSigner.address.toLowerCase(),
  solver: solverVirtual,
  pricingOracle: "0xaf0e1fe8897d2f14209aa8330953917f89f278a2",
  depositor: funderEncoded,
  refundRecipient: funderEncoded,
  priceImpactBps: "200",
  salt: bytesToBigInt(randomBytes(32)).toString(),
};

console.log(`==> funder / depositor / refund (btc): ${funderAddress}`);
console.log(`==> hub trigger submitter (evm):       ${hub.hubSigner.address}`);
console.log(`==> solver (evm):                      ${solver.address} (virtual ${solverVirtual})`);
console.log(`==> chain:                             ${chainSlug}`);
console.log(`==> amount:                            ${amountFloat} BTC (${amount} sat)`);
console.log(`==> api:                               ${apiUrl}`);
console.log();

// ─── Mempool / Esplora helpers ──────────────────────────────────────────────

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean };
}

async function fetchUtxos(address: string): Promise<EsploraUtxo[]> {
  const res = await fetch(`${apiUrl}/address/${address}/utxo`);
  if (!res.ok) {
    throw new Error(`utxo fetch failed (HTTP ${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as EsploraUtxo[];
}

async function fetchFeeRate(): Promise<number> {
  if (explicitFeeRate) {
    return Number(explicitFeeRate);
  }
  const res = await fetch(`${apiUrl}/v1/fees/recommended`);
  if (!res.ok) {
    throw new Error(`fee rate fetch failed (HTTP ${res.status}): ${await res.text()}`);
  }
  const fees = (await res.json()) as { halfHourFee: number; fastestFee: number };
  return fees.halfHourFee || fees.fastestFee;
}

async function broadcastTx(rawHex: string): Promise<string> {
  const res = await fetch(`${apiUrl}/tx`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: rawHex,
  });
  if (!res.ok) {
    throw new Error(`broadcast failed (HTTP ${res.status}): ${await res.text()}`);
  }
  return (await res.text()).trim();
}

async function waitForUtxo(
  address: string,
  minTotalSat: bigint,
  timeoutMs = 10 * 60 * 1000,
): Promise<EsploraUtxo[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await fetchUtxos(address);
    const total = utxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
    if (total >= minTotalSat) {
      return utxos;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`timed out waiting for ${minTotalSat} sat at ${address}`);
}

// ─── 1. Derive deposit address ──────────────────────────────────────────────

const client: DepositAddressesClient = {
  apiBaseUrl: DEFAULT_BASE_URL,
  apiKey: common.usageApiKey,
  pkpId: common.pkpId,
  envName: common.envName,
  vmType: "bitcoin-vm",
};

const account = (await executeLitAction(client, {
  action: "account",
  vmType: "bitcoin-vm",
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
const depositAddress = remoteWallet.address;
const depositPubkey = hexToBytes(remoteWallet.publicKey);
console.log(`==> deposit address: ${depositAddress}`);
console.log();

// ─── 2. Fund the deposit address ────────────────────────────────────────────

const feeRate = await fetchFeeRate();
console.log(`==> fee rate: ${feeRate} sat/vB`);

// Vsize estimate for the deposit tx itself: 11 base bytes + 68 per P2WPKH
// input + 31 per depository/change output + ~100 for the OP_RETURN output.
// Kept in sync with `depositVsize` used during deposit construction.
function depositVsize(numInputs: number): number {
  return 11 + 68 * numInputs + 31 * 2 + 100;
}

async function fundDeposit(): Promise<void> {
  const utxos = await fetchUtxos(depositAddress);
  const have = utxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
  // The deposit tx burns its own fee, so the deposit address must hold
  // `amount + depositFee` after funding. Estimate the deposit tx with one
  // P2WPKH input from the funding output and add a 10% headroom so the
  // funder doesn't have to be re-run on minor fee-rate fluctuations.
  const estDepositFee = BigInt(Math.ceil(feeRate * depositVsize(1)));
  const target = amount + (estDepositFee * 110n) / 100n;
  if (have >= target) {
    console.log(`==> skipping funding: deposit balance ${have} sat >= target ${target} sat`);
    return;
  }
  // Bitcoin nodes reject outputs below the dust threshold (~294 sat for
  // P2WPKH at 3 sat/vB relay). Use 546 as a safe floor; the extra ends up
  // as residual on the deposit address.
  const DUST_SAT = 546n;
  const rawShortfall = target - have;
  const shortfall = rawShortfall < DUST_SAT ? DUST_SAT : rawShortfall;

  const funderUtxos = await fetchUtxos(funderAddress);
  const funderBalance = funderUtxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
  if (funderBalance < shortfall) {
    throw new Error(
      `funder balance ${funderBalance} sat insufficient to cover shortfall ${shortfall} sat`,
    );
  }

  // Select greedy: largest UTXOs first until shortfall + estimated fee covered.
  const sorted = [...funderUtxos].sort((a, b) => b.value - a.value);
  const selected: EsploraUtxo[] = [];
  let acc = 0n;
  // Funding tx vsize estimate: 10.5 + 68 * inputs + 31 * 2 outputs ≈ 10 + 68n + 62.
  const estimateVsize = (n: number) => 10 + 68 * n + 31 * 2;
  let needed = shortfall + BigInt(Math.ceil(feeRate * estimateVsize(1)));
  for (const u of sorted) {
    selected.push(u);
    acc += BigInt(u.value);
    needed = shortfall + BigInt(Math.ceil(feeRate * estimateVsize(selected.length)));
    if (acc >= needed) {
      break;
    }
  }
  if (acc < needed) {
    throw new Error(`unable to assemble enough inputs to cover shortfall ${shortfall}`);
  }
  const fundingFee = BigInt(Math.ceil(feeRate * estimateVsize(selected.length)));
  const change = acc - shortfall - fundingFee;

  const inputs: UnsignedInput[] = selected.map((u) => ({
    txid: hexToBytes(u.txid),
    vout: u.vout,
    valueSat: BigInt(u.value),
  }));
  const outputs: UnsignedOutput[] = [
    { valueSat: shortfall, script: bech32AddressToScript(depositAddress) },
  ];
  if (change > 546n) {
    outputs.push({ valueSat: change, script: bech32AddressToScript(funderAddress) });
  }

  const signatures = inputs.map((_, i) => {
    const digest = sighash(inputs, outputs, i, funderPublicKey);
    const sig = secp256k1.sign(digest, funderPrivateKey, { prehash: false, format: "compact" });
    return sig;
  });
  const raw = composeWitnessTx(inputs, outputs, signatures, funderPublicKey);
  const rawHex = bytesToHex(raw);
  console.log(`==> broadcasting funding tx (${rawHex.length / 2} bytes)`);
  const txid = await broadcastTx(rawHex);
  console.log(`==> funded: ${txid}`);
  console.log(`==> waiting for funding utxo to appear at ${depositAddress} ...`);
  await waitForUtxo(depositAddress, shortfall);
}

await fundDeposit();
console.log();

// ─── 3. Build order + submit trigger ────────────────────────────────────────

const currencies = [
  { chainId: chainSlug, currency: BTC_NATIVE_CURRENCY as Hex },
  { chainId: derivationFields.outputChainId, currency: derivationFields.outputCurrency as Hex },
] as const;
const prices = currencies.map(() => placeholderPrice(BTC_DECIMALS));
const extraData = encodePricesExtraData(prices);
const nonceBig = bytesToBigInt(randomBytes(32));

// Human-readable bech32 form of the native-BTC marker; the SDK encodes it to
// `BTC_NATIVE_CURRENCY` (witness-v0 + 20 zero bytes), matching the trigger's
// `input.currency` and the action's `verifyOrderData` check.
const BTC_NATIVE_ADDRESS = "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8";

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
        currency: BTC_NATIVE_ADDRESS, // SDK normalizes to BTC_NATIVE_CURRENCY
        amount: amount.toString(),
        weight: "1",
      },
      refunds: [
        {
          chainId: chainSlug,
          recipient: funderAddress,
          currency: BTC_NATIVE_ADDRESS,
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
const orderId = getOrderId(order, buildChainsConfig(chainSlug, "bitcoin-vm")) as Hex;
const orderSignature = await solver.signMessage({ message: { raw: orderId } });

// Re-normalize the order to bytes-hex form so it matches what the action's
// `verifyOrderData` checks against the trigger fields.
const normalizedOrder: Order = {
  ...order,
  inputs: order.inputs.map((inp) => ({
    payment: { ...inp.payment, currency: BTC_NATIVE_CURRENCY },
    refunds: inp.refunds.map((r) => ({
      ...r,
      recipient: funderEncoded,
      currency: BTC_NATIVE_CURRENCY,
    })),
  })),
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

// ─── 5. Build unsigned deposit transaction + sighashes ──────────────────────

const depositUtxos = await fetchUtxos(depositAddress);
const sorted = [...depositUtxos].sort((a, b) => b.value - a.value);
const inputs: UnsignedInput[] = [];
let acc = 0n;
for (const u of sorted) {
  inputs.push({ txid: hexToBytes(u.txid), vout: u.vout, valueSat: BigInt(u.value) });
  acc += BigInt(u.value);
  const needed = amount + BigInt(Math.ceil(feeRate * depositVsize(inputs.length)));
  if (acc >= needed) {
    break;
  }
}
const depositFee = explicitDepositFeeSat
  ? BigInt(explicitDepositFeeSat)
  : BigInt(Math.ceil(feeRate * depositVsize(inputs.length)));
if (acc < amount + depositFee) {
  throw new Error(
    `deposit address has ${acc} sat, needs ${amount + depositFee} sat (amount ${amount} + fee ${depositFee})`,
  );
}
const change = acc - amount - depositFee;

// OP_RETURN payload: <orderId>|depositor=<address>|
// (the policy requires the orderId hex prefix and a |depositor=...| field).
const opReturnText = `${orderId}|depositor=${funderAddress}|`;
const opReturnData = new TextEncoder().encode(opReturnText);
if (opReturnData.length > 83) {
  console.warn(
    `==> warning: OP_RETURN payload is ${opReturnData.length} bytes (Bitcoin's default node policy caps datacarrier at 80; some nodes still relay up to 83).`,
  );
}
function opReturnScript(data: Uint8Array): Uint8Array {
  // OP_RETURN <push>
  if (data.length <= 75) {
    return concat([new Uint8Array([OP_RETURN, data.length]), data]);
  }
  if (data.length <= 255) {
    return concat([new Uint8Array([OP_RETURN, 0x4c, data.length]), data]);
  }
  throw new Error("OP_RETURN payload too large");
}

/**
 * Build the depository output script from the SDK-encoded
 * `attestation.inputDepository` bytes. Two encodings are supported:
 *
 *   - Legacy (P2PKH/P2SH): `0xff || versionByte || hash160(20 bytes)`
 *   - Bech32 (v0..v16):    `versionByte || program`
 */
function depositoryOutputScript(encodedHex: string): Uint8Array {
  const encoded = hexToBytes(encodedHex);
  if (encoded[0] === 0xff) {
    if (encoded.length !== 22) {
      throw new Error(
        `legacy bitcoin depository encoding must be 22 bytes (0xff || versionByte || hash160), got ${encoded.length}`,
      );
    }
    const version = encoded[1];
    const hash = encoded.slice(2);
    if (version === 0x00) {
      // P2PKH: OP_DUP OP_HASH160 <20> hash OP_EQUALVERIFY OP_CHECKSIG
      return concat([new Uint8Array([0x76, 0xa9, 0x14]), hash, new Uint8Array([0x88, 0xac])]);
    }
    if (version === 0x05) {
      // P2SH: OP_HASH160 <20> hash OP_EQUAL
      return concat([new Uint8Array([0xa9, 0x14]), hash, new Uint8Array([0x87])]);
    }
    throw new Error(`unsupported legacy bitcoin version byte: 0x${version.toString(16)}`);
  }
  if (encoded.length < 3 || encoded[0] > 16) {
    throw new Error(
      `unsupported bitcoin depository encoding (first byte 0x${encoded[0].toString(16)})`,
    );
  }
  const version = encoded[0];
  const program = encoded.slice(1);
  const versionOp = version === 0 ? 0x00 : 0x50 + version;
  return concat([new Uint8Array([versionOp, program.length]), program]);
}

const depositoryScript = depositoryOutputScript(attestation.inputDepository);

const outputs: UnsignedOutput[] = [
  { valueSat: amount, script: depositoryScript },
  { valueSat: 0n, script: opReturnScript(opReturnData) },
];
if (change > 546n) {
  outputs.push({ valueSat: change, script: bech32AddressToScript(funderAddress) });
}

const unsignedTransaction = `0x${bytesToHex(serializeUnsigned(inputs, outputs))}`;
const sighashes = inputs.map(
  (_, i) => `0x${bytesToHex(sighash(inputs, outputs, i, depositPubkey))}`,
);
const inputValues = inputs.map((i) => i.valueSat.toString());
logSection("unsigned deposit transaction", {
  unsignedTransaction,
  inputValues,
  sighashes,
  outputs: outputs.map((o) => ({
    value: o.valueSat.toString(),
    script: `0x${bytesToHex(o.script)}`,
  })),
  fee: depositFee.toString(),
});

// ─── 6. Lit Action sign ─────────────────────────────────────────────────────

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
    transactions: [{ unsignedTransaction, inputValues, sighashes }],
  },
  solver,
);
const signResult = (await executeLitAction(client, signRequest)) as {
  wallet: LocalWalletInfo;
  triggerHash: string;
  signedTransactions: Array<{ signatures: string[] }>;
};
logSection("lit action sign response", signResult);

// ─── 7. Compose witness + broadcast ─────────────────────────────────────────

const compactSignatures = signResult.signedTransactions[0].signatures.map((s) => hexToBytes(s));
const witnessTx = composeWitnessTx(inputs, outputs, compactSignatures, depositPubkey);
const witnessTxHex = bytesToHex(witnessTx);
console.log(`==> broadcasting deposit tx (${witnessTxHex.length / 2} bytes)`);
const depositTxid = await broadcastTx(witnessTxHex);
console.log(`✓ deposit broadcast: ${depositTxid}`);
console.log();

// ─── 8. Final balances ──────────────────────────────────────────────────────

const residualUtxos = await fetchUtxos(depositAddress);
const residual = residualUtxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
console.log(`==> deposit address residual: ${residual} sat`);
console.log("✓ done");
