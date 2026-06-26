import { base58 } from "https://cdn.jsdelivr.net/npm/@scure/base@2.0.0/+esm";

/** Encode a solana-vm address as raw 32-byte pubkey bytes. */
export function encodeSolanaAddress(address: string): Uint8Array {
  const encoded = base58.decode(address);
  if (encoded.length !== 32) {
    throw new Error("solana-vm address must be 32 bytes");
  }
  return encoded;
}

/** Decode raw solana-vm pubkey bytes into base58. */
export function decodeSolanaAddress(encoded: Uint8Array): string {
  if (encoded.length !== 32) {
    throw new Error("solana-vm encoded address must be 32 bytes");
  }
  return base58.encode(encoded);
}
