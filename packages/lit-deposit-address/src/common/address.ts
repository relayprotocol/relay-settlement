import { bytesToHex, hexToBytes } from "./bytes.js";
import type { VmType } from "./types.js";
import { decodeBitcoinAddress, encodeBitcoinAddress } from "./address/bitcoin.js";
import { decodeEthereumAddress, encodeEthereumAddress } from "./address/ethereum.js";
import { decodeSolanaAddress, encodeSolanaAddress } from "./address/solana.js";

/** Encode a VM-native address with the same bytes representation as the settlement SDK. */
export function encodeAddress(address: string, vmType: VmType): Uint8Array {
  switch (vmType) {
    case "bitcoin-vm":
      return encodeBitcoinAddress(address);
    case "ethereum-vm":
    case "hyperliquid-vm":
      return encodeEthereumAddress(address);
    case "solana-vm":
      return encodeSolanaAddress(address);
  }
}

/** Encode a VM-native address as `0x`-prefixed bytes hex, matching settlement SDK `encodeAddressToHex`. */
export function encodeAddressToHex(address: string, vmType: VmType): string {
  return `0x${bytesToHex(encodeAddress(address, vmType))}`;
}

/** Decode settlement SDK address bytes back into the VM-native string format. */
export function decodeAddress(encoded: Uint8Array, vmType: VmType): string {
  switch (vmType) {
    case "bitcoin-vm":
      return decodeBitcoinAddress(encoded);
    case "ethereum-vm":
    case "hyperliquid-vm":
      return decodeEthereumAddress(encoded);
    case "solana-vm":
      return decodeSolanaAddress(encoded);
  }
}

/** Decode a `0x`-prefixed settlement SDK address encoding back into the VM-native string format. */
export function decodeAddressFromHex(encodedHex: string, vmType: VmType): string {
  return decodeAddress(hexToBytes(encodedHex, "encoded address"), vmType);
}

/**
 * Normalize an SDK-encoded address hex string by decoding and re-encoding it.
 * Useful for strict comparisons against canonical SDK address bytes.
 */
export function normalizeAddressHex(encodedHex: string, vmType: VmType): string {
  return encodeAddressToHex(decodeAddressFromHex(encodedHex, vmType), vmType).toLowerCase();
}

export { decodeBitcoinAddress, encodeBitcoinAddress } from "./address/bitcoin.js";
export { decodeEthereumAddress, encodeEthereumAddress } from "./address/ethereum.js";
export { decodeSolanaAddress, encodeSolanaAddress } from "./address/solana.js";
