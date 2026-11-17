import {
  decodeAccountID,
  encodeAccountID,
  isValidXAddress,
  xAddressToClassicAddress,
} from "https://cdn.jsdelivr.net/npm/ripple-address-codec@5.0.1/+esm";

/** Encode an XRP address as the settlement SDK's 20-byte AccountID. */
export function encodeXrpAddress(address: string): Uint8Array {
  if (isValidXAddress(address)) {
    const decoded = xAddressToClassicAddress(address);
    if (decoded.test) {
      throw new Error("XRP testnet X-addresses are unsupported");
    }
    if (decoded.tag !== false) {
      throw new Error("XRP X-address carries a destination tag; use the classic address");
    }
    return decodeAccountID(decoded.classicAddress);
  }
  return decodeAccountID(address);
}

/** Decode a settlement AccountID as a classic XRP address. */
export function decodeXrpAddress(encoded: Uint8Array): string {
  return encodeAccountID(encoded);
}
