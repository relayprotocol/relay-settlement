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
import bs58 from "bs58";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export type VmType = "ethereum-vm" | "bitcoin-vm" | "solana-vm" | "hyperliquid-vm";

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
    },
  ]);
  const hex = keccak256(encoded).slice(2);
  return Array.from({ length: PATH_SEGMENTS }, (_, i) => {
    return Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16) & UINT31_MASK;
  });
}

async function deserializeAccountNode(account: AccountResponse): Promise<SLIP10Node> {
  return account.vmType === "solana-vm"
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
    const segment =
      vmType === "solana-vm" ? (`cip3:${index}` as const) : (`bip32:${index}` as const);
    node = await node.derive([segment] as unknown as Parameters<typeof node.derive>[0]);
  }
  return node;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function formatAddress(vmType: VmType, node: SLIP10Node): string {
  if (vmType === "ethereum-vm" || vmType === "hyperliquid-vm") {
    const uncompressed = secp256k1.Point.fromHex(bytesToHex(node.compressedPublicKeyBytes)).toBytes(
      false,
    );
    return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
  }
  if (vmType === "bitcoin-vm") {
    const program = ripemd160(sha256(node.compressedPublicKeyBytes));
    return bech32.encode("bc", [0, ...bech32.toWords(program)]);
  }
  return bs58.encode(node.publicKeyBytes);
}

function formatPublicKey(vmType: VmType, node: SLIP10Node): string {
  return vmType === "solana-vm" ? bs58.encode(node.publicKeyBytes) : node.compressedPublicKey;
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
    address: formatAddress(account.vmType, childNode),
    publicKey: formatPublicKey(account.vmType, childNode),
  };
}
