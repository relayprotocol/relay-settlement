import { hkdf } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/hkdf.js/+esm";
import { ripemd160 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { keccak_256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha3.js/+esm";
import { utf8ToBytes } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm";

/**
 * HKDF domain separator. Bumping this invalidates every previously derived
 * deposit address, so it should be treated as a stable protocol constant.
 */
const DOMAIN_SEPARATOR = "lit-deposit-addresses";

/**
 * Derive a 64-byte seed for a specific VM from the PKP root key, using
 * HKDF-SHA256 with the VM family as the info parameter. Different VMs
 * therefore get independent seeds even though they share a root key.
 */
export function deriveVmSeed(rootKey: Uint8Array, vmType: string): Uint8Array {
  return hkdf(sha256, rootKey, utf8ToBytes(DOMAIN_SEPARATOR), utf8ToBytes(vmType), 64);
}

/** Bitcoin's `HASH160 = RIPEMD160(SHA256(data))`. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** Ethereum's `keccak256` hash. */
export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}
