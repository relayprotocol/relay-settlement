#!/usr/bin/env tsx
/**
 * Self-contained solana-vm deposit-address sweep (native SOL + SPL token).
 *
 * Pipeline:
 *   1. Derive the deposit address (Lit Action `account` + `wallet`, plus
 *      off-TEE parity check).
 *   2. Fund the deposit address from `SOLANA_VM_PRIVATE_KEY`:
 *        - native: a single SOL transfer covering `amount + fee buffer`.
 *        - SPL: create the deposit wallet's ATA if missing, transfer the
 *          tokens to it, and top the deposit wallet up with SOL for both
 *          its transaction fee AND the vault-ATA rent the on-chain
 *          `deposit_token` will pay on first use.
 *   3. Build a locally-signed order, then submit `trigger()` on the Base
 *      hub from `HUB_PRIVATE_KEY`.
 *   4. Request an oracle attestation.
 *   5. Build the compiled `deposit_native` or `deposit_token` instruction
 *      with the deposit wallet as the sole signer (= fee payer), feed the
 *      base64 message to the Lit Action's `sign` handler, then broadcast
 *      the returned signed raw transaction.
 *
 * Required env:
 *   LIT_ENV                       environment name (e.g. dev)
 *   LIT_USAGE_API_KEY             Chipotle usage API key authorized for the action
 *   LIT_PKP_ID                    PKP wallet address used by the action
 *   HUB_RPC_URL                   Base hub RPC URL
 *   HUB_PRIVATE_KEY               EVM key that submits trigger() on the
 *                                 Base hub. Its address is also used as
 *                                 the EVM output recipient.
 *   SOLANA_VM_RPC_URL             Solana RPC URL.
 *   SOLANA_VM_PRIVATE_KEY         base58-encoded 64-byte Solana secret
 *                                 key (e.g. Phantom export). Funds the
 *                                 deposit address and acts as the
 *                                 depositor + refund recipient.
 *   SOLANA_VM_CHAIN_ID            Relay chain slug (e.g. "solana").
 *   SOLANA_VM_CURRENCY            mint address (base58) of the asset to
 *                                 deposit; pass `11111111111111111111111111111111`
 *                                 (System Program) for native SOL.
 *   SOLANA_VM_CURRENCY_DECIMALS   decimals to parse SOLANA_VM_AMOUNT with
 *                                 (9 for SOL, 6 for USDC, ...).
 *   SOLANA_VM_AMOUNT              deposit amount as a decimal string in
 *                                 whole units (e.g. "0.001").
 *   SOLVER_PRIVATE_KEY            EVM solver key (0x-prefixed); pin to
 *                                 keep the deposit address stable.
 *
 *   RELAY_ORACLE_URL              oracle base URL.
 *
 * Optional env:
 *   SOLANA_VM_FEE_BUFFER_LAMPORTS lamports the funder leaves on the
 *                                 deposit wallet on top of `amount`
 *                                 (native) or alongside the SPL transfer
 *                                 (token). Default: "5000000" (0.005 SOL).
 *   SOLANA_VM_SPONSOR_GAS         when "true", the funder pays the deposit
 *                                 tx fee (compiled message uses funder as
 *                                 fee payer + slot-0 signer). The action
 *                                 still signs slot 1 with the deposit
 *                                 wallet; this script signs slot 0 with
 *                                 the funder after the action returns.
 */

import { randomBytes } from "node:crypto";
import { bytesToBigInt, formatUnits, parseUnits, type Address, type Hex } from "viem";
import {
  encodeAddress,
  getOrderId,
  type Order,
  type VmType as SdkVmType,
} from "@relay-protocol/settlement-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
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
const sourceRpcUrl = requireEnv("SOLANA_VM_RPC_URL", "Solana RPC URL");
const solanaSecret = requireEnv(
  "SOLANA_VM_PRIVATE_KEY",
  "base58-encoded 64-byte Solana secret key",
);
const chainSlug = requireEnv("SOLANA_VM_CHAIN_ID", 'Relay chain slug for Solana (e.g. "solana")');
const currencyBs58 = requireEnv(
  "SOLANA_VM_CURRENCY",
  "mint address (base58); use `11111111111111111111111111111111` for native SOL",
);
const currencyDecimalsStr = requireEnv(
  "SOLANA_VM_CURRENCY_DECIMALS",
  "decimals to parse SOLANA_VM_AMOUNT (9 for SOL, 6 for USDC, ...)",
);
const amountFloat = requireEnv(
  "SOLANA_VM_AMOUNT",
  'deposit amount as a decimal string (e.g. "0.001")',
);
const feeBufferLamports = BigInt(process.env.SOLANA_VM_FEE_BUFFER_LAMPORTS?.trim() ?? "5000000");
const sponsorGasValue = requireEnv("SOLANA_VM_SPONSOR_GAS", '"true" or "false"').toLowerCase();
if (sponsorGasValue !== "true" && sponsorGasValue !== "false") {
  console.error(`SOLANA_VM_SPONSOR_GAS must be "true" or "false"; got ${sponsorGasValue}`);
  process.exit(1);
}
const sponsorGas = sponsorGasValue === "true";

const currencyDecimals = Number.parseInt(currencyDecimalsStr, 10);
if (!Number.isInteger(currencyDecimals) || currencyDecimals < 0 || currencyDecimals > 36) {
  console.error(
    `SOLANA_VM_CURRENCY_DECIMALS must be an integer in [0, 36]; got ${currencyDecimalsStr}`,
  );
  process.exit(1);
}
let amount: bigint;
try {
  amount = parseUnits(amountFloat, currencyDecimals);
} catch (e) {
  console.error(
    `SOLANA_VM_AMOUNT must parse as a decimal with ${currencyDecimals} decimals; got ${amountFloat} (${
      e instanceof Error ? e.message : e
    })`,
  );
  process.exit(1);
}
if (amount <= 0n) {
  console.error(`SOLANA_VM_AMOUNT must be > 0; got ${amountFloat}`);
  process.exit(1);
}

// ─── Solana constants ───────────────────────────────────────────────────────

const SOLANA_NATIVE_MINT = "11111111111111111111111111111111"; // System Program; SDK convention for native SOL
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RELAY_DEPOSITORY_SEED = new TextEncoder().encode("relay_depository");
const VAULT_SEED = new TextEncoder().encode("vault");
const DEPOSIT_NATIVE_DISCRIMINATOR = new Uint8Array([
  0x0d, 0x9e, 0x0d, 0xdf, 0x5f, 0xd5, 0x1c, 0x06,
]);
const DEPOSIT_TOKEN_DISCRIMINATOR = new Uint8Array([
  0x0b, 0x9c, 0x60, 0xda, 0x27, 0xa3, 0xb4, 0x13,
]);

const mintPubkey = new PublicKey(currencyBs58);
const isNative = currencyBs58 === SOLANA_NATIVE_MINT;

// ─── Wallets ────────────────────────────────────────────────────────────────

const funder = Keypair.fromSecretKey(bs58.decode(solanaSecret));
const sourceConnection = new Connection(sourceRpcUrl, "confirmed");
const hub = createHubClient(common);
const { solver, solverChainIdForOrder, solverVirtual } = createSolverContext(
  common.solverPrivateKey,
);

// ─── Encoders ───────────────────────────────────────────────────────────────

function solanaAddressToHex(pubkey: PublicKey): string {
  return `0x${Buffer.from(pubkey.toBytes()).toString("hex")}`;
}

const currencyHex = solanaAddressToHex(mintPubkey); // 32-byte hex; 32 zeros for native
const funderHex = solanaAddressToHex(funder.publicKey);

// ─── Derivation fields + input ──────────────────────────────────────────────

const input = {
  vmType: "solana-vm" as const,
  chainId: chainSlug,
  currency: currencyHex,
  amount: amount.toString(),
};
const derivationFields: DerivationFields = {
  inputVmType: "solana-vm",
  outputVmType: "ethereum-vm",
  outputChainId: "base",
  outputCurrency: "0x0000000000000000000000000000000000000000",
  outputRecipient: hub.hubSigner.address.toLowerCase(),
  solver: solverVirtual,
  pricingOracle: "0xaf0e1fe8897d2f14209aa8330953917f89f278a2",
  depositor: funderHex,
  refundRecipient: funderHex,
  priceImpactBps: "200",
};

console.log(`==> funder / depositor / refund (solana): ${funder.publicKey.toBase58()}`);
console.log(`==> hub trigger submitter (evm):          ${hub.hubSigner.address}`);
console.log(
  `==> solver (evm):                          ${solver.address} (virtual ${solverVirtual})`,
);
console.log(`==> chain:                                 ${chainSlug}`);
console.log(
  `==> currency:                              ${mintPubkey.toBase58()}${isNative ? " (native SOL)" : " (SPL token)"} (decimals=${currencyDecimals})`,
);
console.log(`==> amount:                                ${amountFloat} (${amount} base units)`);
console.log(
  `==> gas sponsorship:                       ${sponsorGas ? "ENABLED (funder pays sweep tx fee)" : "disabled (deposit wallet pays)"}`,
);
console.log();

// ─── 1. Derive deposit address ──────────────────────────────────────────────

const client: DepositAddressesClient = {
  apiBaseUrl: DEFAULT_BASE_URL,
  apiKey: common.usageApiKey,
  pkpId: common.pkpId,
  envName: common.envName,
  vmType: "solana-vm",
};

const account = (await executeLitAction(client, {
  action: "account",
  vmType: "solana-vm",
})) as AccountResponse;
const remoteWallet = (await executeLitAction(client, {
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
const depositAddress = new PublicKey(remoteWallet.address);
console.log(`==> deposit address: ${depositAddress.toBase58()}`);
console.log();

// ─── Helpers: ATA + SPL transfer + ATA creation ─────────────────────────────

function getAtaAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function createAtaIxIdempotent(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    // 1 = CreateIdempotent (no-op if the ATA already exists)
    data: Buffer.from([1]),
  });
}

function splTransferIx(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  // SPL Token program: instruction 3 = Transfer; data is [3, ...u64 LE amount].
  const data = Buffer.alloc(9);
  data[0] = 3;
  for (let i = 0; i < 8; i++) {
    data[1 + i] = Number((amount >> BigInt(8 * i)) & 0xffn);
  }
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// ─── 2. Fund the deposit address ────────────────────────────────────────────

async function fundNative(): Promise<void> {
  const required = amount + feeBufferLamports;
  const balance = BigInt(await sourceConnection.getBalance(depositAddress, "confirmed"));
  if (balance >= required) {
    console.log(
      `==> skipping native funding: ${depositAddress.toBase58()} balance (${balance}) >= required (${required})`,
    );
    return;
  }
  const fundingAmount = required - balance;
  console.log(
    `==> native funding ${depositAddress.toBase58()} with ${fundingAmount} lamports (balance=${balance}, required=${required})`,
  );
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: depositAddress,
      lamports: Number(fundingAmount),
    }),
  );
  const signature = await sendAndConfirmTransaction(sourceConnection, tx, [funder]);
  console.log(`==> funded: ${signature}`);
}

async function fundSpl(): Promise<void> {
  const funderAta = getAtaAddress(funder.publicKey, mintPubkey);
  const depositAta = getAtaAddress(depositAddress, mintPubkey);

  const [tokenBalanceStr, solBalance, ataInfo] = await Promise.all([
    sourceConnection
      .getTokenAccountBalance(depositAta, "confirmed")
      .then((r) => r.value.amount)
      .catch(() => "0"),
    sourceConnection.getBalance(depositAddress, "confirmed"),
    sourceConnection.getAccountInfo(depositAta, "confirmed"),
  ]);
  const tokenBalance = BigInt(tokenBalanceStr);
  const solBalanceBig = BigInt(solBalance);

  const tokenSufficient = tokenBalance >= amount;
  const solSufficient = solBalanceBig >= feeBufferLamports;
  const ataExists = ataInfo !== null;

  if (tokenSufficient && solSufficient && ataExists) {
    console.log(
      `==> skipping spl funding: deposit ATA exists, token balance (${tokenBalance}) >= amount (${amount}), sol balance (${solBalanceBig}) >= buffer (${feeBufferLamports})`,
    );
    return;
  }

  console.log(`==> spl funding`);
  console.log(`    funder ATA:  ${funderAta.toBase58()}`);
  console.log(`    deposit ATA: ${depositAta.toBase58()}${ataExists ? " (exists)" : " (create)"}`);
  console.log(
    `    transfer:    ${tokenSufficient ? "skip" : `${amount - tokenBalance} (balance=${tokenBalance}, amount=${amount})`}`,
  );
  console.log(
    `    gas top-up:  ${solSufficient ? "skip" : `${feeBufferLamports - solBalanceBig} (balance=${solBalanceBig}, buffer=${feeBufferLamports})`}`,
  );

  const tx = new Transaction();
  if (!ataExists) {
    // CreateIdempotent costs ~0.002 SOL of rent paid by the funder.
    tx.add(createAtaIxIdempotent(funder.publicKey, depositAta, depositAddress, mintPubkey));
  }
  if (!solSufficient) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: depositAddress,
        lamports: Number(feeBufferLamports - solBalanceBig),
      }),
    );
  }
  if (!tokenSufficient) {
    tx.add(splTransferIx(funderAta, depositAta, funder.publicKey, amount - tokenBalance));
  }
  const signature = await sendAndConfirmTransaction(sourceConnection, tx, [funder]);
  console.log(`==> funded: ${signature}`);
}

if (isNative) {
  await fundNative();
} else {
  await fundSpl();
}
console.log();

// ─── 3. Build order + submit trigger ────────────────────────────────────────

const currencies = [
  { chainId: chainSlug, currency: currencyHex as Hex },
  { chainId: derivationFields.outputChainId, currency: derivationFields.outputCurrency as Hex },
] as const;
const prices = currencies.map(() => placeholderPrice(currencyDecimals));
const extraData = encodePricesExtraData(prices);
const nonce = bytesToBigInt(randomBytes(32));

// The SDK's `normalizeOrder` runs each address-like field through
// `encodeAddressToHex(addr, vmType)`; for solana-vm that means bs58.decode,
// so the order must carry the *VM-native* representation (base58 for solana,
// 0x-hex for EVM). The trigger payload sent to the contract still uses the
// already-encoded hex form because the contract ABI is `bytes`.
const currencyForOrder = mintPubkey.toBase58();
const funderForOrder = funder.publicKey.toBase58();
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
        currency: currencyForOrder,
        amount: amount.toString(),
        weight: "1",
      },
      refunds: [
        {
          chainId: chainSlug,
          recipient: funderForOrder,
          currency: currencyForOrder,
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
const chainsConfig: Record<string, SdkVmType> = buildChainsConfig(chainSlug, "solana-vm");
const orderId = getOrderId(order, chainsConfig) as Hex;
const orderSignature = await solver.signMessage({ message: { raw: orderId } });

/**
 * Per-VM hex-encode helper. Mirrors what the SDK's `normalizeOrder` does
 * internally so the order we hand to the Lit Action matches what the
 * verifier compares against the trigger fields (already bytes-hex).
 */
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

// ─── 5. Build deposit instruction ───────────────────────────────────────────

function hexToBytes(value: string): Uint8Array {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

const programId = new PublicKey(hexToBytes(attestation.inputDepository));
const [relayDepositoryPda] = PublicKey.findProgramAddressSync([RELAY_DEPOSITORY_SEED], programId);
const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SEED], programId);
const idBytes = hexToBytes(orderId);
if (idBytes.length !== 32) {
  throw new Error(`orderId must be 32 bytes; got ${idBytes.length}`);
}

function depositInstructionData(discriminator: Uint8Array): Uint8Array {
  const data = new Uint8Array(8 + 8 + 32);
  data.set(discriminator, 0);
  for (let i = 0; i < 8; i++) {
    data[8 + i] = Number((amount >> BigInt(8 * i)) & 0xffn);
  }
  data.set(idBytes, 16);
  return data;
}

let depositIx: TransactionInstruction;
if (isNative) {
  depositIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: relayDepositoryPda, isSigner: false, isWritable: false },
      { pubkey: depositAddress, isSigner: true, isWritable: true },
      { pubkey: funder.publicKey, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(depositInstructionData(DEPOSIT_NATIVE_DISCRIMINATOR)),
  });
} else {
  const senderAta = getAtaAddress(depositAddress, mintPubkey);
  const vaultAta = getAtaAddress(vaultPda, mintPubkey);
  depositIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: relayDepositoryPda, isSigner: false, isWritable: false },
      { pubkey: depositAddress, isSigner: true, isWritable: true },
      { pubkey: funder.publicKey, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: mintPubkey, isSigner: false, isWritable: false },
      { pubkey: senderAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(depositInstructionData(DEPOSIT_TOKEN_DISCRIMINATOR)),
  });
}

const balance = BigInt(await sourceConnection.getBalance(depositAddress, "confirmed"));
console.log(`==> deposit wallet SOL balance: ${balance} lamports`);
if (isNative) {
  if (balance < amount + 5_000n) {
    throw new Error(
      `deposit wallet balance (${balance}) is below input.amount + min fee (${amount + 5_000n}); funding step failed`,
    );
  }
}

// When gas is sponsored, the funder becomes the fee payer (slot 0) and the
// deposit wallet drops to slot 1. The compiler still adds the deposit
// wallet as a signer because its `isSigner: true` is set on the instruction
// account list, so the resulting message has numRequiredSignatures = 2.
const { blockhash } = await sourceConnection.getLatestBlockhash("finalized");
const message = new TransactionMessage({
  payerKey: sponsorGas ? funder.publicKey : depositAddress,
  recentBlockhash: blockhash,
  instructions: [depositIx],
}).compileToV0Message();
const tx = new VersionedTransaction(message);
const messageBase64 = Buffer.from(tx.message.serialize()).toString("base64");

logSection("solana sweep", {
  from: depositAddress.toBase58(),
  program: programId.toBase58(),
  relayDepository: relayDepositoryPda.toBase58(),
  vault: vaultPda.toBase58(),
  depositor: funder.publicKey.toBase58(),
  isNative,
  amount: amount.toString(),
  blockhash,
});

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
    order: normalizedOrder as unknown as Record<string, unknown>,
    orderSignature,
    transactions: [{ message: messageBase64 }],
  },
  solver,
);
const signResult = (await executeLitAction(client, signRequest)) as {
  wallet: LocalWalletInfo;
  triggerHash: string;
  signedTransactions: Array<{ signature: string; rawTransaction: string }>;
};
logSection("lit action sign response", signResult);

// ─── 7. Broadcast ──────────────────────────────────────────────────────────

let rawTransaction = Buffer.from(signResult.signedTransactions[0].rawTransaction, "base64");
if (sponsorGas) {
  // The action returned a partially-signed tx (slot 0 = 64 zero bytes,
  // slot 1 = deposit wallet's ed25519 signature). Sign slot 0 with the
  // funder so the transaction has all required signatures before broadcast.
  const partiallySigned = VersionedTransaction.deserialize(new Uint8Array(rawTransaction));
  partiallySigned.sign([funder]);
  rawTransaction = Buffer.from(partiallySigned.serialize());
  console.log(`==> funder signed slot 0 (gas sponsor)`);
}
const sweepSig = await sourceConnection.sendRawTransaction(rawTransaction, {
  skipPreflight: false,
  preflightCommitment: "confirmed",
});
console.log(`==> broadcast: ${sweepSig}`);
const latest = await sourceConnection.getLatestBlockhash("confirmed");
const confirmation = await sourceConnection.confirmTransaction(
  {
    signature: sweepSig,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  },
  "confirmed",
);
if (confirmation.value.err) {
  console.error(`✗ sweep reverted: ${JSON.stringify(confirmation.value.err)}`);
  process.exit(1);
}
console.log(`✓ sweep mined: ${sweepSig}`);
console.log();

// ─── 8. Final balances ─────────────────────────────────────────────────────

const finalSol = await sourceConnection.getBalance(depositAddress, "confirmed");
if (isNative) {
  console.log(`==> deposit address residual balance: ${formatUnits(BigInt(finalSol), 9)} SOL`);
} else {
  const ata = getAtaAddress(depositAddress, mintPubkey);
  const tokenAccount = await sourceConnection.getTokenAccountBalance(ata).catch(() => undefined);
  const tokenBalance = tokenAccount?.value?.amount ?? "0";
  console.log(
    `==> deposit address residual: ${formatUnits(BigInt(tokenBalance), currencyDecimals)} (${tokenBalance} base units of ${mintPubkey.toBase58()}) + ${formatUnits(BigInt(finalSol), 9)} SOL gas`,
  );
}
console.log("✓ done");
