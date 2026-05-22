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
