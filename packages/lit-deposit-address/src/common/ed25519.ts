import { ed25519Bip32 } from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm";
import { ed25519 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/ed25519.js/+esm";
import { sha512 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { bytesToNumberLE, concatBytes, numberToBytesLE } from "./bytes.js";

/**
 * Sign `message` with a BIP32-Ed25519 extended secret (`kL || kR`).
 *
 * Standard Ed25519 derives the scalar from SHA-512 of a 32-byte seed, but
 * CIP-3/BIP32-Ed25519 stores the extended secret directly. We reimplement the
 * variant so `@noble/curves` Ed25519 isn't asked to clamp/hash our seed.
 *
 * The resulting `(R, S)` pair is a standard RFC-8032 Ed25519 signature: it
 * verifies under the public key `ed25519Bip32.getPublicKey(privateKey)` with
 * any conformant verifier (Solana's runtime, TON's `check_signature`, etc.).
 */
export function signEd25519Bip32(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
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
