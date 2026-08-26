/**
 * Self-contained off-TEE deposit-address derivation.
 *
 * Mirrors `src/derivation/path.ts` and `src/derivation/vm/*.ts` (public
 * derivation only) so callers can verify the `wallet` Lit Action's response
 * locally without TEE access. The logic must stay in sync with the in-TEE
 * derivation; the `cross-derivation.test.ts` test enforces parity.
 */

import { SLIP10Node } from "@metamask/key-tree";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bech32 } from "@scure/base";
import { WalletContractV5R1 } from "@ton/ton";
import bs58 from "bs58";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export type VmType =
  | "ethereum-vm"
  | "bitcoin-vm"
  | "solana-vm"
  | "hyperliquid-vm"
  | "ton-vm"
  | "tron-vm";

export interface AccountResponse {
  vmType: VmType;
  accountPath: string;
  publicKey: string;
  extendedPublicKey: string;
}

export interface DerivationFields {
  inputVmType: VmType;
  outputVmType: VmType;
  outputChainId: string;
  outputCurrency: string;
  outputRecipient: string;
  solver: string;
  pricingOracle: string;
  depositor: string;
  refundRecipient: string;
  priceImpactBps: string;
  salt: string;
}

export interface LocalWalletInfo {
  vmType: VmType;
  indexes: number[];
  path: string;
  address: string;
  publicKey: string;
}

const DERIVATION_FIELDS_ABI = [
  {
    type: "tuple",
    components: [
      { name: "inputVmType", type: "string" },
      { name: "outputVmType", type: "string" },
      { name: "outputChainId", type: "string" },
      { name: "outputCurrency", type: "bytes" },
      { name: "outputRecipient", type: "bytes" },
      { name: "solver", type: "address" },
      { name: "pricingOracle", type: "address" },
      { name: "depositor", type: "bytes" },
      { name: "refundRecipient", type: "bytes" },
      { name: "priceImpactBps", type: "uint256" },
      { name: "salt", type: "uint256" },
    ],
  },
] as const;

const PATH_SEGMENTS = 8;
const UINT31_MASK = 0x7fff_ffff;

/** Match `src/derivation/path.ts#derivationFieldsToIndexes`. */
export function derivationFieldsToIndexes(fields: DerivationFields): number[] {
  const encoded = encodeAbiParameters(DERIVATION_FIELDS_ABI, [
    {
      inputVmType: fields.inputVmType,
      outputVmType: fields.outputVmType,
      outputChainId: fields.outputChainId,
      outputCurrency: fields.outputCurrency as Hex,
      outputRecipient: fields.outputRecipient as Hex,
      solver: fields.solver as Address,
      pricingOracle: fields.pricingOracle as Address,
      depositor: fields.depositor as Hex,
      refundRecipient: fields.refundRecipient as Hex,
      priceImpactBps: BigInt(fields.priceImpactBps),
      salt: BigInt(fields.salt),
    },
  ]);
  const hex = keccak256(encoded).slice(2);
  return Array.from({ length: PATH_SEGMENTS }, (_, i) => {
    return Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16) & UINT31_MASK;
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Per-VM derivation behaviour. Adding a VM is a single new entry here; the
 * existing entries (and the generic derivation flow below) stay untouched.
 */
interface VmDerivation {
  /** CIP-3 / BIP32-Ed25519 (publicly derivable) vs. secp256k1 BIP32. */
  ed25519Bip32: boolean;
  /** Format the VM-native address from a derived node. */
  formatAddress: (node: SLIP10Node) => string;
  /** Format the VM-native public key from a derived node. */
  formatPublicKey: (node: SLIP10Node) => string;
}

const evmAddress = (node: SLIP10Node): string => {
  const uncompressed = secp256k1.Point.fromHex(bytesToHex(node.compressedPublicKeyBytes)).toBytes(
    false,
  );
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
};
const compressedPublicKey = (node: SLIP10Node): string => node.compressedPublicKey;
const base58PublicKey = (node: SLIP10Node): string => bs58.encode(node.publicKeyBytes);
const tronAddress = (node: SLIP10Node): string => {
  const uncompressed = secp256k1.Point.fromHex(bytesToHex(node.compressedPublicKeyBytes)).toBytes(
    false,
  );
  const payload = Uint8Array.of(0x41, ...keccak_256(uncompressed.slice(1)).slice(12));
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return bs58.encode(Uint8Array.of(...payload, ...checksum));
};

const VM_DERIVATION: Record<VmType, VmDerivation> = {
  "ethereum-vm": {
    ed25519Bip32: false,
    formatAddress: evmAddress,
    formatPublicKey: compressedPublicKey,
  },
  "hyperliquid-vm": {
    ed25519Bip32: false,
    formatAddress: evmAddress,
    formatPublicKey: compressedPublicKey,
  },
  "bitcoin-vm": {
    ed25519Bip32: false,
    formatAddress: (node) =>
      bech32.encode("bc", [0, ...bech32.toWords(ripemd160(sha256(node.compressedPublicKeyBytes)))]),
    formatPublicKey: compressedPublicKey,
  },
  "solana-vm": {
    ed25519Bip32: true,
    formatAddress: base58PublicKey,
    formatPublicKey: base58PublicKey,
  },
  "ton-vm": {
    ed25519Bip32: true,
    // Wallet V5R1 StateInit address; @ton/ton is the canonical reference and
    // must agree with the in-TEE hand-rolled cell hashing.
    formatAddress: (node) =>
      WalletContractV5R1.create({
        workchain: 0,
        publicKey: Buffer.from(node.publicKeyBytes),
      }).address.toRawString(),
    formatPublicKey: (node) => `0x${Buffer.from(node.publicKeyBytes).toString("hex")}`,
  },
  "tron-vm": {
    ed25519Bip32: false,
    formatAddress: tronAddress,
    formatPublicKey: compressedPublicKey,
  },
};

async function deserializeAccountNode(account: AccountResponse): Promise<SLIP10Node> {
  return VM_DERIVATION[account.vmType].ed25519Bip32
    ? SLIP10Node.fromJSON(
        JSON.parse(account.extendedPublicKey) as Parameters<typeof SLIP10Node.fromJSON>[0],
      )
    : SLIP10Node.fromExtendedKey(account.extendedPublicKey);
}

async function deriveChildAtPath(
  vmType: VmType,
  account: SLIP10Node,
  indexes: readonly number[],
): Promise<SLIP10Node> {
  let node = account;
  for (const index of indexes) {
    const segment = VM_DERIVATION[vmType].ed25519Bip32
      ? (`cip3:${index}` as const)
      : (`bip32:${index}` as const);
    node = await node.derive([segment] as unknown as Parameters<typeof node.derive>[0]);
  }
  return node;
}

/**
 * Derive a deposit wallet locally from an account-level public root and a set
 * of derivation fields. Produces the same `address` / `publicKey` as the
 * `wallet` Lit Action.
 */
export async function deriveDepositWallet(
  account: AccountResponse,
  derivationFields: DerivationFields,
): Promise<LocalWalletInfo> {
  if (account.vmType !== derivationFields.inputVmType) {
    throw new Error(
      `account.vmType (${account.vmType}) must match derivationFields.inputVmType (${derivationFields.inputVmType})`,
    );
  }
  const indexes = derivationFieldsToIndexes(derivationFields);
  const accountNode = await deserializeAccountNode(account);
  const childNode = await deriveChildAtPath(account.vmType, accountNode, indexes);
  return {
    vmType: account.vmType,
    indexes,
    path: `${account.accountPath}/${indexes.join("/")}`,
    address: VM_DERIVATION[account.vmType].formatAddress(childNode),
    publicKey: VM_DERIVATION[account.vmType].formatPublicKey(childNode),
  };
}
