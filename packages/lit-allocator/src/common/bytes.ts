/**
 * Byte / hex / bigint primitives shared across the action source.
 *
 * Keep these self-contained — the action bundle runs inside the TEE without
 * Node-specific helpers (`Buffer`, etc.), so everything here works against
 * plain `Uint8Array`s and standard `String` methods.
 */

/**
 * Normalize a hex string by removing an optional 0x prefix, validating it,
 * and lowercasing it.
 */
export function normalizeHex(hex: unknown, field = "hex"): string {
  const clean = String(hex ?? "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`invalid hex for ${field}: ${hex}`);
  }
  return clean.toLowerCase();
}

/** Convert a hex string into bytes after validation. */
export function hexToBytes(hex: unknown, field = "hex"): Uint8Array {
  const clean = normalizeHex(hex, field);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Convert bytes into a lowercase hex string without a 0x prefix. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Concatenate any number of byte arrays into a new Uint8Array. */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

/** Compare two byte arrays for exact byte equality. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
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

/** Interpret big-endian bytes as an unsigned bigint. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) {
    n = (n << 8n) + BigInt(b);
  }
  return n;
}

/** Encode an unsigned bigint as minimal-length big-endian bytes. */
export function bigIntToBytes(value: bigint): Uint8Array {
  if (value === 0n) {
    return new Uint8Array(0);
  }
  let hex = value.toString(16);
  if (hex.length % 2) {
    hex = `0${hex}`;
  }
  return hexToBytes(hex, "quantity");
}

/** Ensure a byte array has the expected fixed length. */
export function expectLength(bytes: Uint8Array, length: number, field: string): Uint8Array {
  if (bytes.length !== length) {
    throw new Error(`${field} must be exactly ${length} bytes`);
  }
  return bytes;
}
