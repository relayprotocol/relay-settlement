import { bytesToHex, hexToBytes } from "../bytes.js";

/**
 * Encode a hyperliquid-vm identifier as raw bytes.
 *
 * Hyperliquid uses EVM-style 20-byte account addresses, but also carries
 * shorter hex identifiers in protocol address-like fields (for example
 * 16-byte token ids). Unlike ethereum-vm, do not require exactly 20 bytes.
 */
export function encodeHyperliquidAddress(address: string): Uint8Array {
  const encoded = hexToBytes(address, "address");
  if (encoded.length === 0 || encoded.length > 20) {
    throw new Error("hyperliquid-vm address must be between 1 and 20 bytes");
  }
  return encoded;
}

/** Decode raw hyperliquid-vm address/identifier bytes into 0x-prefixed hex. */
export function decodeHyperliquidAddress(encoded: Uint8Array): string {
  if (encoded.length === 0 || encoded.length > 20) {
    throw new Error("hyperliquid-vm encoded address must be between 1 and 20 bytes");
  }
  return `0x${bytesToHex(encoded)}`;
}

/** Encode a hyperliquid-vm identifier as `0x`-prefixed SDK bytes hex. */
export function encodeHyperliquidAddressToHex(address: string): string {
  return `0x${bytesToHex(encodeHyperliquidAddress(address))}`;
}

/** Round-trip SDK-encoded hyperliquid-vm address hex through the codec. */
export function normalizeHyperliquidAddressHex(encodedHex: string): string {
  return encodeHyperliquidAddressToHex(
    decodeHyperliquidAddress(hexToBytes(encodedHex, "encoded address")),
  ).toLowerCase();
}
