import {
  SLIP10Node,
  ed25519Bip32,
} from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm#sha384-iWbSDJToETb8472qJVfgUl0vgl03s8An4v0EtHgKVwHrYQFjgbPU8Xu9n83+plLN";
import { ed25519 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/ed25519.js/+esm#sha384-Bdcn5+otxW5DZgXyuQ8l2JyyG6Op7ZzGm5KrBjD0Q/8vkBtT4KsX7abNZPcelj2p";
import { pbkdf2 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/pbkdf2.js/+esm#sha384-D5VIsA1sKtlUy0alXi0qwfCSsGkk/yblfbRQCtvHiyLjsS8FbWSPqf5Ot1CVMXsZ";
import { sha512 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm#sha384-fpq5UdD7vTx0NhDc6RRBoykedv2HsZB3RxSOX130Tk6qLqG1jtQzuXISijyF++FS";
import bs58 from "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm#sha384-obRIzJpHEltALtaRu+VVERKw4iCzb8EUZaHzlyuZvEbHzDKHIiaO0940L3FlRjee";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToNumberLE,
  concatBytes,
  hexToBytes,
  numberToBytesLE,
} from "../../../common/bytes.js";
import { deriveVmSeed } from "../../../common/crypto.js";
import type {
  AccountInfo,
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  SolanaVmSignedTransaction,
  SolanaVmTransaction,
  WalletInfo,
} from "../../../common/types.js";
import { VmWalletDeriver } from "../base/VmWalletDeriver.js";

// Anchor instruction discriminators: sha256("global:<name>")[0..8].
// Hardcoded to avoid hashing the signature string at every verification call.
const DEPOSIT_NATIVE_DISCRIMINATOR = new Uint8Array([
  0x0d, 0x9e, 0x0d, 0xdf, 0x5f, 0xd5, 0x1c, 0x06,
]);
const DEPOSIT_TOKEN_DISCRIMINATOR = new Uint8Array([
  0x0b, 0x9c, 0x60, 0xda, 0x27, 0xa3, 0xb4, 0x13,
]);

// Account-slot indexes inside each Anchor instruction (must match the
// `#[derive(Accounts)]` definitions in the relay-depository program).
const ANCHOR_SENDER_INDEX = 1;
const NATIVE_ACCOUNT_DEPOSITOR_INDEX = 2;
const NATIVE_ACCOUNT_COUNT = 5;
const TOKEN_ACCOUNT_DEPOSITOR_INDEX = 2;
const TOKEN_ACCOUNT_MINT_INDEX = 4;
const TOKEN_ACCOUNT_COUNT = 10;

// We support at most one additional signer (the fee payer); the deposit
// wallet is always the last signer slot.
const MAX_REQUIRED_SIGNATURES = 2;
const SIGNATURE_LEN = 64;

// Instruction data layout: 8-byte Anchor discriminator + u64 amount (LE) + [u8; 32] id.
const DEPOSIT_ARGS_LEN = 8 + 8 + 32;
const DEPOSIT_AMOUNT_OFFSET = 8;
const DEPOSIT_AMOUNT_END = 16;
const DEPOSIT_ID_OFFSET = 16;
const DEPOSIT_ID_END = 48;

const PUBKEY_LEN = 32;

/** CIP-3 account path segments after the root node (m / 44' / 501' / 0' / 0). */
const ACCOUNT_SEGMENTS = ["cip3:44'", "cip3:501'", "cip3:0'", "cip3:0"] as const;

/** PBKDF2 iteration count for CIP-3 root-node derivation. */
const PBKDF2_ITERATIONS = 4096;

/**
 * Solana wallet deriver using the publicly derivable Ed25519 (CIP-3 / BIP32-Ed25519)
 * scheme so that child wallets can be derived from the account extended public
 * key alone. This differs from Solana's standard SLIP-0010 which is hardened-only
 * and therefore not externally derivable.
 *
 * Transaction signing accepts base64-encoded compiled message bytes with one
 * or two required signatures. The derived wallet must occupy the last signer
 * slot; if there is a separate fee payer, its signature slot is returned as a
 * zero-filled placeholder for the caller to fill later.
 */
export class SolanaVmWalletDeriver extends VmWalletDeriver<
  SolanaVmTransaction,
  SolanaVmSignedTransaction
> {
  readonly vmType = "solana-vm" as const;
  protected readonly accountPath = "m/44'/501'/0'/0";

  /**
   * Reject any unsigned transaction batch that doesn't match the expected
   * deposit shape for the current trigger.
   *
   * Two flows are accepted, dispatched on `trigger.input.currency`:
   *
   * 1. Native (`input.currency` = 32 zero bytes a.k.a. the System Program):
   *    a single Solana transaction containing exactly one instruction
   *    calling `deposit_native(amount, id)` on the program identified by
   *    `attestation.inputDepository`, with exactly 5 accounts (Anchor
   *    layout: relay_depository, sender, depositor, vault, system_program).
   *
   * 2. SPL (anything else): same, but the instruction calls
   *    `deposit_token(amount, id)` with the 10 Anchor accounts
   *    (relay_depository, sender, depositor, vault, mint,
   *    sender_token_account, vault_token_account, token_program,
   *    associated_token_program, system_program). The `mint` account must
   *    resolve to `trigger.input.currency`.
   *
   * In both flows the `depositor` account must resolve to
   * `trigger.derivationFields.depositor`, and the Borsh-encoded args must
   * carry `amount == input.amount` and `id == trigger.orderId`.
   *
   * Address-table-lookup accounts (introduced by versioned-v0 messages) are
   * not supported: an instruction whose account index falls outside the
   * static account-keys array is rejected.
   */
  override verifyTransactions(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly SolanaVmTransaction[],
  ): void {
    if (transactions.length !== 1) {
      throw new Error(`solana deposit requires exactly 1 transaction, got ${transactions.length}`);
    }
    const parsed = parseSolanaCompiledMessage(base64ToBytes(transactions[0].message));

    // Accept either:
    //  - 1 required signature: deposit wallet IS the fee payer (slot 0),
    //  - 2 required signatures: deposit wallet is slot 1, separate fee payer at slot 0.
    // Higher signer counts are rejected to keep the threat model small — every
    // extra signer is one more authority that could be coerced into signing
    // unintended state changes.
    if (
      parsed.numRequiredSignatures < 1 ||
      parsed.numRequiredSignatures > MAX_REQUIRED_SIGNATURES
    ) {
      throw new Error(
        `transactions[0]: numRequiredSignatures must be 1 or 2 (got ${parsed.numRequiredSignatures})`,
      );
    }
    if (parsed.instructions.length !== 1) {
      throw new Error(
        `transactions[0]: solana deposit message must contain exactly 1 instruction, got ${parsed.instructions.length}`,
      );
    }
    const ix = parsed.instructions[0];

    // The Anchor `sender` (the wallet whose SOL or tokens flow out) must be
    // the deposit wallet. The signer pins the deposit wallet to the LAST
    // signer slot (slot 0 when 1 signer, slot 1 when 2 signers), so this
    // pin-by-index gate is equivalent to pin-by-pubkey without needing the
    // wallet's pubkey here in the verifier.
    const expectedSenderSlot = parsed.numRequiredSignatures - 1;
    const actualSenderSlot = ix.accountIndexes[ANCHOR_SENDER_INDEX];
    if (actualSenderSlot !== expectedSenderSlot) {
      throw new Error(
        `transactions[0]: instruction sender slot must be ${expectedSenderSlot} (the deposit wallet), got ${actualSenderSlot}`,
      );
    }

    // Program id must equal `attestation.inputDepository` (the relay
    // depository program's id encoded as 32 raw bytes hex).
    const expectedProgram = hex32Bytes(attestation.inputDepository, "attestation.inputDepository");
    const programKey = resolveStaticKey(parsed, ix.programIdIndex, "instruction.programIdIndex");
    if (!bytesEqual(programKey, expectedProgram)) {
      throw new Error(
        `transactions[0]: instruction program mismatch: expected=${attestation.inputDepository}, got=0x${bytesToHex(programKey)}`,
      );
    }

    const expectedDepositor = hex32Bytes(
      trigger.derivationFields.depositor,
      "trigger.derivationFields.depositor",
    );
    const expectedAmount = BigInt(trigger.input.amount);
    const expectedOrderId = hex32Bytes(trigger.orderId, "trigger.orderId");
    const currencyBytes = hex32Bytes(trigger.input.currency, "trigger.input.currency");

    if (isZeroBytes(currencyBytes)) {
      this.verifyDepositNative(parsed, ix, expectedDepositor, expectedAmount, expectedOrderId);
    } else {
      this.verifyDepositToken(
        parsed,
        ix,
        expectedDepositor,
        expectedAmount,
        expectedOrderId,
        currencyBytes,
      );
    }
  }

  /** Validate the native (system-program) deposit instruction. */
  private verifyDepositNative(
    parsed: ParsedSolanaMessage,
    ix: ParsedSolanaInstruction,
    expectedDepositor: Uint8Array,
    expectedAmount: bigint,
    expectedOrderId: Uint8Array,
  ): void {
    if (ix.data.length !== DEPOSIT_ARGS_LEN) {
      throw new Error(
        `transactions[0]: deposit_native: instruction data must be ${DEPOSIT_ARGS_LEN} bytes, got ${ix.data.length}`,
      );
    }
    if (!bytesEqual(ix.data.slice(0, 8), DEPOSIT_NATIVE_DISCRIMINATOR)) {
      throw new Error(
        `transactions[0]: instruction discriminator does not match deposit_native (expected=0x${bytesToHex(DEPOSIT_NATIVE_DISCRIMINATOR)}, got=0x${bytesToHex(ix.data.slice(0, 8))})`,
      );
    }
    if (ix.accountIndexes.length !== NATIVE_ACCOUNT_COUNT) {
      throw new Error(
        `transactions[0]: deposit_native must reference exactly ${NATIVE_ACCOUNT_COUNT} accounts, got ${ix.accountIndexes.length}`,
      );
    }
    const depositor = resolveStaticKey(
      parsed,
      ix.accountIndexes[NATIVE_ACCOUNT_DEPOSITOR_INDEX],
      "deposit_native.depositor",
    );
    if (!bytesEqual(depositor, expectedDepositor)) {
      throw new Error(
        `transactions[0]: deposit_native.depositor mismatch: expected=0x${bytesToHex(expectedDepositor)}, got=0x${bytesToHex(depositor)}`,
      );
    }
    const amount = bytesToNumberLE(ix.data.slice(DEPOSIT_AMOUNT_OFFSET, DEPOSIT_AMOUNT_END));
    if (amount !== expectedAmount) {
      throw new Error(
        `transactions[0]: deposit_native.amount mismatch: expected=${expectedAmount}, got=${amount}`,
      );
    }
    const id = ix.data.slice(DEPOSIT_ID_OFFSET, DEPOSIT_ID_END);
    if (!bytesEqual(id, expectedOrderId)) {
      throw new Error(
        `transactions[0]: deposit_native.id mismatch: expected=0x${bytesToHex(expectedOrderId)}, got=0x${bytesToHex(id)}`,
      );
    }
  }

  /** Validate the SPL-token deposit instruction. */
  private verifyDepositToken(
    parsed: ParsedSolanaMessage,
    ix: ParsedSolanaInstruction,
    expectedDepositor: Uint8Array,
    expectedAmount: bigint,
    expectedOrderId: Uint8Array,
    expectedMint: Uint8Array,
  ): void {
    if (ix.data.length !== DEPOSIT_ARGS_LEN) {
      throw new Error(
        `transactions[0]: deposit_token: instruction data must be ${DEPOSIT_ARGS_LEN} bytes, got ${ix.data.length}`,
      );
    }
    if (!bytesEqual(ix.data.slice(0, 8), DEPOSIT_TOKEN_DISCRIMINATOR)) {
      throw new Error(
        `transactions[0]: instruction discriminator does not match deposit_token (expected=0x${bytesToHex(DEPOSIT_TOKEN_DISCRIMINATOR)}, got=0x${bytesToHex(ix.data.slice(0, 8))})`,
      );
    }
    if (ix.accountIndexes.length !== TOKEN_ACCOUNT_COUNT) {
      throw new Error(
        `transactions[0]: deposit_token must reference exactly ${TOKEN_ACCOUNT_COUNT} accounts, got ${ix.accountIndexes.length}`,
      );
    }
    const depositor = resolveStaticKey(
      parsed,
      ix.accountIndexes[TOKEN_ACCOUNT_DEPOSITOR_INDEX],
      "deposit_token.depositor",
    );
    if (!bytesEqual(depositor, expectedDepositor)) {
      throw new Error(
        `transactions[0]: deposit_token.depositor mismatch: expected=0x${bytesToHex(expectedDepositor)}, got=0x${bytesToHex(depositor)}`,
      );
    }
    const mint = resolveStaticKey(
      parsed,
      ix.accountIndexes[TOKEN_ACCOUNT_MINT_INDEX],
      "deposit_token.mint",
    );
    if (!bytesEqual(mint, expectedMint)) {
      throw new Error(
        `transactions[0]: deposit_token.mint mismatch: expected=0x${bytesToHex(expectedMint)}, got=0x${bytesToHex(mint)}`,
      );
    }
    const amount = bytesToNumberLE(ix.data.slice(DEPOSIT_AMOUNT_OFFSET, DEPOSIT_AMOUNT_END));
    if (amount !== expectedAmount) {
      throw new Error(
        `transactions[0]: deposit_token.amount mismatch: expected=${expectedAmount}, got=${amount}`,
      );
    }
    const id = ix.data.slice(DEPOSIT_ID_OFFSET, DEPOSIT_ID_END);
    if (!bytesEqual(id, expectedOrderId)) {
      throw new Error(
        `transactions[0]: deposit_token.id mismatch: expected=0x${bytesToHex(expectedOrderId)}, got=0x${bytesToHex(id)}`,
      );
    }
  }

  protected async deriveAccountNode(rootKeyHex: string): Promise<SLIP10Node> {
    const rootKey = hexToBytes(rootKeyHex, "rootKeyHex");
    const entropy = deriveVmSeed(rootKey, this.vmType);

    // CIP-3 root-node clamping over a PBKDF2-stretched master key.
    const rootNode = pbkdf2(sha512, ed25519Bip32.secret, entropy, {
      c: PBKDF2_ITERATIONS,
      dkLen: 96,
    });
    rootNode[0] &= 0b1111_1000;
    rootNode[31] &= 0b0001_1111;
    rootNode[31] |= 0b0100_0000;

    const master = await SLIP10Node.fromExtendedKey({
      depth: 0,
      parentFingerprint: 0,
      index: 0,
      chainCode: rootNode.slice(64),
      privateKey: rootNode.slice(0, 64),
      curve: "ed25519Bip32",
    });

    return master.derive(ACCOUNT_SEGMENTS);
  }

  protected deserializeAccountNode(extendedPublicKey: string): Promise<SLIP10Node> {
    return SLIP10Node.fromJSON(
      JSON.parse(extendedPublicKey) as Parameters<typeof SLIP10Node.fromJSON>[0],
    );
  }

  protected deriveChildNode(node: SLIP10Node, index: number): Promise<SLIP10Node> {
    return node.derive([`cip3:${index}`]);
  }

  protected accountFromNode(accountNode: SLIP10Node): AccountInfo {
    return {
      vmType: this.vmType,
      accountPath: this.accountPath,
      publicKey: bs58.encode(accountNode.publicKeyBytes),
      extendedPublicKey: JSON.stringify(accountNode.neuter().toJSON()),
    };
  }

  protected walletFromNode(indexes: readonly number[], childNode: SLIP10Node): WalletInfo {
    const address = bs58.encode(childNode.publicKeyBytes);
    return {
      vmType: this.vmType,
      indexes: [...indexes],
      path: this.path(indexes),
      address,
      publicKey: address,
    };
  }

  protected async signTransactionWithKey(
    privateKey: Uint8Array,
    transaction: SolanaVmTransaction,
  ): Promise<SolanaVmSignedTransaction> {
    const messageBytes = base64ToBytes(transaction.message);
    if (messageBytes.length === 0) {
      throw new Error("solana transaction message is empty");
    }
    const parsed = parseSolanaCompiledMessage(messageBytes);

    // Accept either:
    //  - 1 required signature: deposit wallet is the sole signer + fee payer,
    //  - 2 required signatures: deposit wallet is the second signer; an
    //    external fee payer signs slot 0 after the action returns.
    if (
      parsed.numRequiredSignatures < 1 ||
      parsed.numRequiredSignatures > MAX_REQUIRED_SIGNATURES
    ) {
      throw new Error(
        `only 1 or 2 required signatures are supported (got ${parsed.numRequiredSignatures})`,
      );
    }

    // Verify the deposit wallet is at the LAST signer slot. This is the
    // contract verifyTransactions relies on to pin the Anchor `sender` to
    // the deposit wallet without knowing the wallet's pubkey.
    const walletSlot = parsed.numRequiredSignatures - 1;
    const walletPubkey = ed25519Bip32.getPublicKey(privateKey);
    if (!bytesEqual(parsed.staticAccountKeys[walletSlot], walletPubkey)) {
      throw new Error(
        `deposit wallet must occupy signer slot ${walletSlot} of the compiled message`,
      );
    }

    const signature = signEd25519Bip32(messageBytes, privateKey);

    // Wire format: shortvec(N) || sig_0 || sig_1 || … || message.
    // Slots other than the wallet's get 64 zero-byte placeholders. With
    // `numRequiredSignatures == 2`, the fee payer signs slot 0 in-place
    // after the action returns (eg. by calling Transaction.partialSign).
    const sigs = new Uint8Array(parsed.numRequiredSignatures * SIGNATURE_LEN);
    sigs.set(signature, walletSlot * SIGNATURE_LEN);
    const rawTransaction = concatBytes(
      new Uint8Array([parsed.numRequiredSignatures]),
      sigs,
      messageBytes,
    );
    return {
      signature: `0x${bytesToHex(signature)}`,
      rawTransaction: bytesToBase64(rawTransaction),
    };
  }
}

// ─── Solana compiled-message parser ─────────────────────────────────────────

interface ParsedSolanaInstruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

interface ParsedSolanaMessage {
  /** Number of required signatures (header byte 0). */
  numRequiredSignatures: number;
  staticAccountKeys: Uint8Array[];
  instructions: ParsedSolanaInstruction[];
}

/**
 * Parse the raw bytes of a Solana compiled transaction message into its
 * header info, static account keys, and compiled instructions. Supports both
 * legacy and versioned v0 messages — for v0 the address-table-lookup section
 * is parsed enough to pass over (any instruction that references a
 * non-static account index is rejected later by `resolveStaticKey`).
 */
function parseSolanaCompiledMessage(bytes: Uint8Array): ParsedSolanaMessage {
  if (bytes.length === 0) {
    throw new Error("transactions[0]: solana message is empty");
  }
  const reader = new ByteReader(bytes);

  // Versioned messages have a leading marker byte with the high bit set
  // (0x80 | version). v0 is the only deployed version today.
  if ((bytes[0] & 0x80) !== 0) {
    const version = reader.readByte() & 0x7f;
    if (version !== 0) {
      throw new Error(`transactions[0]: unsupported solana message version v${version}`);
    }
  }

  // Header: num_required_signatures, num_readonly_signed, num_readonly_unsigned.
  const numRequiredSignatures = reader.readByte();
  reader.skip(2);

  const numAccounts = reader.readShortU16();
  const staticAccountKeys: Uint8Array[] = [];
  for (let i = 0; i < numAccounts; i++) {
    staticAccountKeys.push(reader.read(PUBKEY_LEN));
  }

  // Recent blockhash — not used for verification but must be consumed.
  reader.skip(32);

  const numInstructions = reader.readShortU16();
  const instructions: ParsedSolanaInstruction[] = [];
  for (let i = 0; i < numInstructions; i++) {
    const programIdIndex = reader.readByte();
    const numIxAccounts = reader.readShortU16();
    const accountIndexes: number[] = [];
    for (let j = 0; j < numIxAccounts; j++) {
      accountIndexes.push(reader.readByte());
    }
    const dataLen = reader.readShortU16();
    const data = reader.read(dataLen);
    instructions.push({ programIdIndex, accountIndexes, data });
  }

  // Any trailing bytes (address-table-lookups for v0) are intentionally
  // ignored — we reject instructions that depend on them via
  // `resolveStaticKey`.

  return { numRequiredSignatures, staticAccountKeys, instructions };
}

class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  read(n: number): Uint8Array {
    this.requireRemaining(n);
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  readByte(): number {
    this.requireRemaining(1);
    return this.bytes[this.offset++];
  }

  skip(n: number): void {
    this.requireRemaining(n);
    this.offset += n;
  }

  /**
   * Solana "shortvec" / short-u16: variable-length 7-bits-per-byte encoding,
   * up to 16 bits total (3 bytes max). The continuation bit on each byte
   * signals "more bytes follow".
   */
  readShortU16(): number {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.readByte();
      if (i < 2) {
        value |= (b & 0x7f) << (i * 7);
        if ((b & 0x80) === 0) {
          return value;
        }
      } else {
        // Third byte caps at 2 bits (total = 16 bits = 65535).
        if ((b & 0xfc) !== 0) {
          throw new Error("transactions[0]: invalid shortvec encoding (third byte > 0x03)");
        }
        value |= b << 14;
        return value;
      }
    }
    throw new Error("transactions[0]: malformed shortvec");
  }

  private requireRemaining(n: number): void {
    if (this.offset + n > this.bytes.length) {
      throw new Error(
        `transactions[0]: solana message truncated (need ${n} more bytes at offset ${this.offset}, have ${this.bytes.length - this.offset})`,
      );
    }
  }
}

// ─── Verification helpers ───────────────────────────────────────────────────

/** Resolve a static account-key index, rejecting address-table-lookup refs. */
function resolveStaticKey(parsed: ParsedSolanaMessage, index: number, field: string): Uint8Array {
  if (index >= parsed.staticAccountKeys.length) {
    throw new Error(
      `transactions[0]: ${field} references account index ${index} which is outside the static account keys (length=${parsed.staticAccountKeys.length}); address-table-lookups are not supported`,
    );
  }
  return parsed.staticAccountKeys[index];
}

/** Decode a 32-byte bytes-hex pubkey, asserting it's exactly 32 bytes. */
function hex32Bytes(hex: string, field: string): Uint8Array {
  const bytes = hexToBytes(hex, field);
  if (bytes.length !== PUBKEY_LEN) {
    throw new Error(`${field} must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

function isZeroBytes(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b !== 0) {
      return false;
    }
  }
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Sign `message` with a BIP32-Ed25519 extended secret (`kL || kR`).
 *
 * Standard Ed25519 derives the scalar from SHA-512 of a 32-byte seed, but
 * CIP-3/BIP32-Ed25519 stores the extended secret directly. Reimplement the
 * variant so `@noble/curves` Ed25519 isn't asked to clamp/hash our seed.
 */
function signEd25519Bip32(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const kL = privateKey.slice(0, 32);
  const kR = privateKey.slice(32, 64);
  const order = ed25519.Point.Fn.ORDER;
  const scalar = bytesToNumberLE(kL) % order;
  const r = bytesToNumberLE(sha512(concatBytes(kR, message))) % order;
  const publicKey = ed25519Bip32.getPublicKey(privateKey);
  const encodedR = ed25519.Point.BASE.multiply(r).toBytes();
  const challenge = bytesToNumberLE(sha512(concatBytes(encodedR, publicKey, message))) % order;
  const s = (r + challenge * scalar) % order;
  return concatBytes(encodedR, numberToBytesLE(s, 32));
}
