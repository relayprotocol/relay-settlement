/**
 * Cryptographic primitives used by the Lit Action.
 *
 * - `keccak`: keccak-256 via @noble/hashes loaded from jsDelivr
 * - `deriveKey`: HKDF-SHA256 over the PKP private key, using the static
 *   `"relay-allocator"` salt and a per-VM `info` value. Run inside the TEE
 *   so the derived material never leaves the enclave.
 */

import { keccak_256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/sha3/+esm";
import { hexToBytes } from "./bytes.js";

/**
 * HKDF salt that scopes every derived VM key to this allocator program.
 * Changing this value invalidates every wallet address derived from a PKP.
 */
const DOMAIN_SEPARATOR = "relay-allocator";
const encoder = new TextEncoder();

/** Compute Keccak-256 over the provided bytes. */
export function keccak(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(keccak_256(bytes));
}

/** Compute HMAC-SHA256 using WebCrypto, available in the Lit Action runtime. */
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, data as unknown as BufferSource);
  return new Uint8Array(mac);
}

/** Perform the HKDF-Extract step with HMAC-SHA256. */
async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt, ikm);
}

/** Perform the HKDF-Expand step with HMAC-SHA256. */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const hashLen = 32;
  const n = Math.ceil(length / hashLen);
  const okm: Uint8Array<ArrayBufferLike> = new Uint8Array(n * hashLen);
  let prev: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  for (let i = 1; i <= n; i++) {
    const input: Uint8Array<ArrayBufferLike> = new Uint8Array(prev.length + info.length + 1);
    input.set(prev, 0);
    input.set(info, prev.length);
    input[prev.length + info.length] = i;
    prev = await hmacSha256(prk, input);
    okm.set(prev, (i - 1) * hashLen);
  }

  return new Uint8Array(okm.slice(0, length));
}

/**
 * Derive 32 bytes of VM-specific key material from the PKP private key.
 * Uses HKDF-SHA256(salt="relay-allocator", info=vmType).
 */
export async function deriveKey(pkpPrivateKeyHex: string, vmTypeInfo: string): Promise<Uint8Array> {
  const ikm = hexToBytes(pkpPrivateKeyHex, "pkpPrivateKey");
  const salt = encoder.encode(DOMAIN_SEPARATOR);
  const info = encoder.encode(vmTypeInfo);
  const prk = await hkdfExtract(salt, ikm);
  return hkdfExpand(prk, info, 32);
}
