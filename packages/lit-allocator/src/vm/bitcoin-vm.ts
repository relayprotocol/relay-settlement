/**
 * Lit Action: Bitcoin signer.
 *
 * Runs inside Lit's TEE. Derives a native SegWit (bc1/P2WPKH) Bitcoin
 * address from the PKP private key and signs withdraw request hashes proven by
 * an oracle attestation.
 */
import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import { ripemd160 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { sign as secpSign } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/utils.js/+esm";
import {
  bytesToHex,
  deriveKey,
  hexToBytes,
  verifyWithdrawRequestAttestation,
  type WithdrawRequestAttestation,
  type WithdrawRequest,
} from "../common/index.js";
import {
  ALLOCATOR_ADDRESS,
  ALLOWED_ORACLES,
  HUB_EVM_CHAIN_ID,
  ORACLE_SIGNATURE_THRESHOLD,
} from "../config.js";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

interface BitcoinActionParams {
  pkpId: string;
  action: "wallet" | "sign" | string;
  withdrawRequest?: WithdrawRequest;
  attestation?: WithdrawRequestAttestation;
}

interface BitcoinWalletResult {
  vmType: "bitcoin-vm";
  /** Native SegWit P2WPKH address (bc1...). */
  address: string;
}

interface BitcoinSignResult extends BitcoinWalletResult {
  withdrawRequestHash: string;
  results: Array<{
    hash: string;
    /** secp256k1 signature in r+s+v form (v = 27 or 28), 65 bytes hex. */
    signature: string;
  }>;
}

async function deriveBitcoinPrivateKeyHex(pkpPrivateKeyHex: string): Promise<string> {
  return bytesToHex(await deriveKey(pkpPrivateKeyHex, "bitcoin-vm"));
}

function bitcoinAddressFromPrivateKey(privateKeyHex: string): string {
  const publicKey = secp256k1.getPublicKey(hexToBytes(`0x${privateKeyHex}`), true);
  const publicKeyHash = ripemd160(sha256(publicKey));
  return encodeBech32("bc", [0, ...convertBits(publicKeyHash, 8, 5, true)]);
}

function signDigest(messageHash: Uint8Array, privateKeyHex: string): string {
  const recovered = secpSign(messageHash, hexToBytes(`0x${privateKeyHex}`)).toBytes("recovered");
  const signature = new Uint8Array(65);
  signature.set(recovered.slice(1), 0);
  signature[64] = recovered[0] === 0 ? 27 : 28;
  return `0x${bytesToHex(signature)}`;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error("invalid bech32 input value");
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error("invalid bech32 padding");
  }

  return result;
}

function encodeBech32(hrp: string, data: number[]): string {
  const checksum = createChecksum(hrp, data);
  return `${hrp}1${[...data, ...checksum].map((value) => BECH32_CHARSET[value]).join("")}`;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const result: number[] = [];
  for (let p = 0; p < 6; p++) {
    result.push((mod >> (5 * (5 - p))) & 31);
  }
  return result;
}

function hrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) >> 5);
  }
  result.push(0);
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) & 31);
  }
  return result;
}

function polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if (((top >> i) & 1) !== 0) {
        chk ^= generators[i];
      }
    }
  }
  return chk;
}

export async function main({
  pkpId,
  action,
  withdrawRequest,
  attestation,
}: BitcoinActionParams): Promise<BitcoinWalletResult | BitcoinSignResult> {
  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const bitcoinPrivateKey = await deriveBitcoinPrivateKeyHex(pkpPrivateKey);

  if (action === "wallet") {
    return {
      vmType: "bitcoin-vm",
      address: bitcoinAddressFromPrivateKey(bitcoinPrivateKey),
    };
  }

  if (action === "sign") {
    if (!withdrawRequest) {
      throw new Error("withdrawRequest is required");
    }
    if (!attestation) {
      throw new Error("attestation is required");
    }

    const { withdrawRequestHash, hashesToSign } = verifyWithdrawRequestAttestation(
      withdrawRequest,
      attestation,
      ALLOCATOR_ADDRESS,
      HUB_EVM_CHAIN_ID,
      ALLOWED_ORACLES,
      ORACLE_SIGNATURE_THRESHOLD,
    );

    return {
      vmType: "bitcoin-vm",
      address: bitcoinAddressFromPrivateKey(bitcoinPrivateKey),
      withdrawRequestHash: `0x${bytesToHex(withdrawRequestHash)}`,
      results: hashesToSign.map((hash) => ({
        hash: `0x${bytesToHex(hash)}`,
        signature: signDigest(hash, bitcoinPrivateKey),
      })),
    };
  }

  throw new Error(`unknown action: ${action}`);
}
