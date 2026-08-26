import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { base58 } from "https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm";
import { bytesToHex, concatBytes, hexToBytes } from "../bytes.js";
import { keccak256 } from "../crypto.js";

const TRON_MAINNET_PREFIX = 0x41;
const TRON_ADDRESS_LENGTH = 21;
const CHECKSUM_LENGTH = 4;

/** Compare two byte arrays without coercing either representation. */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/** Compute the four-byte Base58Check checksum used by Tron addresses. */
function checksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).slice(0, CHECKSUM_LENGTH);
}

/** Decode and validate a canonical Tron mainnet Base58Check address. */
export function encodeTronAddress(address: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(address);
  } catch {
    throw new Error("invalid Tron address encoding");
  }
  if (decoded.length !== TRON_ADDRESS_LENGTH + CHECKSUM_LENGTH) {
    throw new Error("invalid Tron address length");
  }
  const payload = decoded.slice(0, TRON_ADDRESS_LENGTH);
  if (payload[0] !== TRON_MAINNET_PREFIX) {
    throw new Error("invalid Tron address prefix");
  }
  if (!bytesEqual(decoded.slice(TRON_ADDRESS_LENGTH), checksum(payload))) {
    throw new Error("invalid Tron address checksum");
  }
  return payload;
}

/** Encode settlement-compatible Tron address bytes as canonical Base58Check. */
export function decodeTronAddress(encoded: Uint8Array): string {
  if (encoded.length !== TRON_ADDRESS_LENGTH) {
    throw new Error("invalid Tron address length");
  }
  if (encoded[0] !== TRON_MAINNET_PREFIX) {
    throw new Error("invalid Tron address prefix");
  }
  return base58.encode(concatBytes(encoded, checksum(encoded)));
}

/** Derive a canonical Tron address from a compressed or uncompressed secp256k1 public key. */
export function tronAddressFromPublicKey(publicKeyHex: string): string {
  const publicKey = hexToBytes(publicKeyHex, "Tron public key");
  const uncompressed = secp256k1.Point.fromHex(bytesToHex(publicKey)).toBytes(false);
  const payload = concatBytes(
    Uint8Array.of(TRON_MAINNET_PREFIX),
    keccak256(uncompressed.slice(1)).slice(12),
  );
  return decodeTronAddress(payload);
}
