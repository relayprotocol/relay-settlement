import { bytesToHex, hexToBytes } from "../bytes.js";

/** Encode an ethereum-vm address as raw 20-byte address bytes. */
export function encodeEthereumAddress(address: string): Uint8Array {
  const encoded = hexToBytes(address, "address");
  if (encoded.length !== 20) {
    throw new Error("ethereum-vm address must be 20 bytes");
  }
  return encoded;
}

/** Decode raw ethereum-vm address bytes into 0x-prefixed hex. */
export function decodeEthereumAddress(encoded: Uint8Array): string {
  if (encoded.length !== 20) {
    throw new Error("ethereum-vm encoded address must be 20 bytes");
  }
  return `0x${bytesToHex(encoded)}`;
}

/** Encode an ethereum-vm address as `0x`-prefixed SDK bytes hex. */
export function encodeEthereumAddressToHex(address: string): string {
  return `0x${bytesToHex(encodeEthereumAddress(address))}`;
}

/** Round-trip SDK-encoded ethereum-vm address hex through the codec. */
export function normalizeEthereumAddressHex(encodedHex: string): string {
  return encodeEthereumAddressToHex(
    decodeEthereumAddress(hexToBytes(encodedHex, "encoded address")),
  ).toLowerCase();
}
