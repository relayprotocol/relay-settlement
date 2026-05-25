import { base58, bech32, bech32m } from "https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { bytesToHex } from "../bytes.js";

const BITCOIN_MAINNET_P2PKH_VERSION = 0x00;
const BITCOIN_MAINNET_P2SH_VERSION = 0x05;
const BITCOIN_MAINNET_HRP = "bc";
const LEGACY_BITCOIN_ADDRESS_DISCRIMINATOR = 0xff;

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((acc, part) => acc + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
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

function doubleSha256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

function encodeBase58CheckPayload(address: string): Uint8Array {
  const decoded = base58.decode(address);
  if (decoded.length < 5) {
    throw new Error("invalid bitcoin base58 address");
  }
  const payload = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const expected = doubleSha256(payload).slice(0, 4);
  if (!bytesEqual(checksum, expected)) {
    throw new Error("invalid bitcoin base58 checksum");
  }
  return payload;
}

function decodeBase58CheckPayload(payload: Uint8Array): string {
  return base58.encode(concatBytes([payload, doubleSha256(payload).slice(0, 4)]));
}

/** Encode a bitcoin-vm address with settlement SDK-compatible bytes. */
export function encodeBitcoinAddress(address: string): Uint8Array {
  if (address.startsWith("1") || address.startsWith("3")) {
    const payload = encodeBase58CheckPayload(address);
    if (
      payload.length !== 21 ||
      (payload[0] !== BITCOIN_MAINNET_P2PKH_VERSION && payload[0] !== BITCOIN_MAINNET_P2SH_VERSION)
    ) {
      throw new Error("unsupported bitcoin base58 address format");
    }
    return Uint8Array.from([LEGACY_BITCOIN_ADDRESS_DISCRIMINATOR, ...payload]);
  }

  if (address.toLowerCase().startsWith(`${BITCOIN_MAINNET_HRP}1`)) {
    const lower = address.toLowerCase() as `${string}1${string}`;
    try {
      const decoded = bech32.decode(lower, 90);
      if (decoded.prefix === BITCOIN_MAINNET_HRP && decoded.words[0] === 0) {
        return Uint8Array.from([decoded.words[0], ...bech32.fromWords(decoded.words.slice(1))]);
      }
    } catch {
      // Try bech32m below.
    }

    const decoded = bech32m.decode(lower, 90);
    if (decoded.prefix === BITCOIN_MAINNET_HRP && decoded.words[0] >= 1) {
      return Uint8Array.from([decoded.words[0], ...bech32.fromWords(decoded.words.slice(1))]);
    }
  }

  throw new Error("unsupported bitcoin address format");
}

/** Decode settlement SDK-compatible bitcoin-vm address bytes. */
export function decodeBitcoinAddress(encoded: Uint8Array): string {
  if (encoded[0] === LEGACY_BITCOIN_ADDRESS_DISCRIMINATOR) {
    const payload = encoded.slice(1);
    if (
      payload.length !== 21 ||
      (payload[0] !== BITCOIN_MAINNET_P2PKH_VERSION && payload[0] !== BITCOIN_MAINNET_P2SH_VERSION)
    ) {
      throw new Error("unsupported legacy bitcoin address encoding");
    }
    return decodeBase58CheckPayload(payload);
  }

  if (encoded.length < 3) {
    throw new Error("unsupported bitcoin address encoding");
  }
  const version = encoded[0];
  if (version > 16) {
    throw new Error("unsupported bitcoin witness version");
  }
  const words = [version, ...bech32.toWords(encoded.slice(1))];
  if (version === 0) {
    return bech32.encode(BITCOIN_MAINNET_HRP, words);
  }
  return bech32m.encode(BITCOIN_MAINNET_HRP, words);
}

/** Convenience helper for tests and error messages. */
export function encodeBitcoinAddressToHex(address: string): string {
  return `0x${bytesToHex(encodeBitcoinAddress(address))}`;
}
