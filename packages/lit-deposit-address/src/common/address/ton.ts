import { base64ToBytes, bytesToHex, hexToBytes } from "../bytes.js";

/**
 * TON address codec mirroring the settlement SDK's `ton-vm` encoding: the
 * canonical on-the-wire form is the 32-byte StateInit account hash, with the
 * workchain implied to be 0 (basechain). Each Relay chainId maps to a single
 * TON workchain, so a non-basechain address is treated as a mismatch.
 *
 * `encodeTonAddress` accepts both the raw `0:<hex>` form and the user-facing
 * base64 "friendly" form (url-safe or standard, bounceable or not).
 */

const RAW_ADDRESS_RE = /^(-?\d+):([0-9a-fA-F]{64})$/;
const FRIENDLY_LENGTH = 36;

/** Encode a TON address string into its 32-byte basechain account hash. */
export function encodeTonAddress(address: string): Uint8Array {
  const raw = RAW_ADDRESS_RE.exec(address.trim());
  if (raw) {
    const workchain = Number.parseInt(raw[1], 10);
    if (workchain !== 0) {
      throw new Error(
        `TON address on workchain ${workchain} does not match the expected basechain (workchain 0)`,
      );
    }
    return hexToBytes(raw[2], "ton address");
  }
  return decodeFriendly(address.trim());
}

/** Encode a TON address as `0x`-prefixed 32-byte hash, for SDK comparisons. */
export function encodeTonAddressToHex(address: string): string {
  return `0x${bytesToHex(encodeTonAddress(address))}`;
}

/** Decode a 32-byte basechain account hash into the raw `0:<hex>` form. */
export function decodeTonAddress(encoded: Uint8Array): string {
  if (encoded.length !== 32) {
    throw new Error(`invalid TON address byte length ${encoded.length}; expected 32`);
  }
  return `0:${bytesToHex(encoded)}`;
}

/** Decode a base64 "friendly" TON address, validating its CRC16 checksum. */
function decodeFriendly(address: string): Uint8Array {
  const normalized = address.replace(/-/g, "+").replace(/_/g, "/");
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(normalized);
  } catch {
    throw new Error(`invalid TON address: ${address}`);
  }
  if (bytes.length !== FRIENDLY_LENGTH) {
    throw new Error(`invalid TON address: ${address}`);
  }
  const payload = bytes.slice(0, 34);
  const checksum = (bytes[34] << 8) | bytes[35];
  if (crc16(payload) !== checksum) {
    throw new Error(`invalid TON address checksum: ${address}`);
  }
  // payload[0] is the tag (bounceable/test flags); payload[1] is the workchain.
  const workchain = payload[1] === 0xff ? -1 : payload[1];
  if (workchain !== 0) {
    throw new Error(
      `TON address on workchain ${workchain} does not match the expected basechain (workchain 0)`,
    );
  }
  return payload.slice(2, 34);
}

/** CRC16/XMODEM (poly 0x1021, init 0) — the checksum TON friendly forms use. */
function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}
