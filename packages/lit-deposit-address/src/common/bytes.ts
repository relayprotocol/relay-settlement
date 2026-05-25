import {
  bytesToHex as nobleBytesToHex,
  concatBytes as nobleConcatBytes,
  hexToBytes as nobleHexToBytes,
} from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm";

/**
 * Decode a hex string (with or without `0x` prefix) to bytes. Throws with a
 * named error if the value is not a valid even-length hex string.
 */
export function hexToBytes(value: string, name: string): Uint8Array {
  try {
    return nobleHexToBytes(value.startsWith("0x") ? value.slice(2) : value);
  } catch {
    throw new Error(`${name} must be an even-length hex string`);
  }
}

/** Encode bytes as a lowercase hex string without a `0x` prefix. */
export function bytesToHex(value: Uint8Array): string {
  return nobleBytesToHex(value);
}

/** Concatenate any number of byte arrays into a single `Uint8Array`. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  return nobleConcatBytes(...parts);
}

/**
 * Encode a non-negative bigint as little-endian bytes of fixed length.
 * Throws if the value does not fit.
 */
export function numberToBytesLE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let current = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(current & 0xffn);
    current >>= 8n;
  }
  if (current !== 0n) {
    throw new Error("number does not fit in target length");
  }
  return out;
}

/** Decode little-endian bytes as a non-negative bigint. */
export function bytesToNumberLE(value: Uint8Array): bigint {
  let out = 0n;
  for (let i = value.length - 1; i >= 0; i--) {
    out = (out << 8n) | BigInt(value[i]);
  }
  return out;
}

/** Encode bytes as a standard base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a base64 string into bytes. */
export function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
