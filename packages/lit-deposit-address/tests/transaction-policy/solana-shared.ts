import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
} from "../../src/common/types.js";
import { makeAttestation, makeTrigger } from "./shared.js";

export const SOLANA_DEPOSITORY_HEX = ("0x" + "11".repeat(32)) as `0x${string}`; // 32-byte program id (raw bytes hex)
export const SOLANA_DEPOSITOR_HEX = ("0x" + "22".repeat(32)) as `0x${string}`;
export const SOLANA_MINT_HEX = ("0x" + "33".repeat(32)) as `0x${string}`;
export const SOLANA_ZERO_HEX = ("0x" + "00".repeat(32)) as `0x${string}`;
export const SOLANA_ORDER_ID: `0x${string}` = ("0x" + "ab".repeat(32)) as `0x${string}`;
export const SOLANA_INPUT_AMOUNT = 1_234_567n;

export const DEPOSIT_NATIVE_DISCRIMINATOR_BYTES = new Uint8Array([
  0x0d, 0x9e, 0x0d, 0xdf, 0x5f, 0xd5, 0x1c, 0x06,
]);
export const DEPOSIT_TOKEN_DISCRIMINATOR_BYTES = new Uint8Array([
  0x0b, 0x9c, 0x60, 0xda, 0x27, 0xa3, 0xb4, 0x13,
]);

export function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) {
    throw new Error(`expected 32 bytes hex, got ${clean.length / 2} bytes`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeShortU16(value: number): Uint8Array {
  if (value < 0 || value > 0xffff) {
    throw new Error(`shortvec out of range: ${value}`);
  }
  if (value < 0x80) {
    return new Uint8Array([value]);
  }
  if (value < 0x4000) {
    return new Uint8Array([(value & 0x7f) | 0x80, (value >> 7) & 0x7f]);
  }
  return new Uint8Array([
    (value & 0x7f) | 0x80,
    ((value >> 7) & 0x7f) | 0x80,
    (value >> 14) & 0x03,
  ]);
}

function encodeU64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) {
    total += a.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/**
 * Build a base64-encoded legacy Solana compiled message containing exactly
 * one instruction. The instruction's `data` carries the Anchor discriminator
 * + Borsh-encoded `(amount, id)` args. `accountIndexes` is an array of
 * static-account-key indexes that the instruction references in Anchor order.
 */
export interface SolanaMessageInputs {
  numRequiredSignatures?: number; // defaults to 1
  staticAccountKeys: Uint8Array[];
  instructions: Array<{
    programIdIndex: number;
    accountIndexes: number[];
    data: Uint8Array;
  }>;
}

export function buildLegacyMessage(inputs: SolanaMessageInputs): string {
  const n = inputs.numRequiredSignatures ?? 1;
  // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned.
  // numReadonlyUnsigned is the number of read-only non-signer accounts;
  // for our purposes it doesn't have to be exact, the verifier doesn't read
  // it.
  const header = new Uint8Array([n, 0, 1]);
  const numKeys = encodeShortU16(inputs.staticAccountKeys.length);
  const keys = concat(...inputs.staticAccountKeys);
  const blockhash = new Uint8Array(32); // zeros
  const numIxs = encodeShortU16(inputs.instructions.length);
  const ixs: Uint8Array[] = [];
  for (const ix of inputs.instructions) {
    const ixBytes = concat(
      new Uint8Array([ix.programIdIndex]),
      encodeShortU16(ix.accountIndexes.length),
      new Uint8Array(ix.accountIndexes),
      encodeShortU16(ix.data.length),
      ix.data,
    );
    ixs.push(ixBytes);
  }
  const out = concat(header, numKeys, keys, blockhash, numIxs, ...ixs);
  return Buffer.from(out).toString("base64");
}

export function buildDepositArgs(
  discriminator: Uint8Array,
  amount: bigint,
  orderId: `0x${string}`,
): Uint8Array {
  return concat(discriminator, encodeU64LE(amount), hexToBytes32(orderId));
}

export function makeSolanaTrigger(
  overrides: { inputCurrency?: `0x${string}` } = {},
): DepositAddressTrigger {
  return {
    ...makeTrigger({ inputVmType: "solana-vm", inputCurrency: overrides.inputCurrency }),
    input: {
      vmType: "solana-vm",
      chainId: "solana",
      currency: overrides.inputCurrency ?? SOLANA_ZERO_HEX,
      amount: SOLANA_INPUT_AMOUNT.toString(),
    },
    derivationFields: {
      ...makeTrigger({ inputVmType: "solana-vm" }).derivationFields,
      depositor: SOLANA_DEPOSITOR_HEX,
      refundRecipient: SOLANA_DEPOSITOR_HEX,
    },
    orderId: SOLANA_ORDER_ID,
  };
}

export function makeSolanaAttestation(): DepositAddressTriggerAttestation {
  return { ...makeAttestation(), inputDepository: SOLANA_DEPOSITORY_HEX };
}
