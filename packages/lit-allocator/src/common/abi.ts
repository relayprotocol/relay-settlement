/**
 * Solidity ABI encoding helpers for the allocator's withdraw request.
 *
 * `computeWithdrawRequestHash` reproduces the exact `keccak256(abi.encode(...))`
 * the allocator contract computes on-chain, so the Lit Action can verify the
 * hash an oracle attests to.
 */

import { concatBytes, hexToBytes } from "./bytes.js";
import { keccak } from "./crypto.js";
import type { WithdrawRequest } from "./types.js";

/** Accepted input types for ABI quantity fields. */
type QuantityInput = string | number | bigint;

/** Parse a decimal or 0x-prefixed Ethereum quantity into a bigint. */
export function parseQuantity(value: QuantityInput, field: string): bigint {
  const s = String(value ?? "");
  if (s.length === 0) {
    throw new Error(`invalid quantity for ${field}`);
  }
  return BigInt(s);
}

/** Encode a uint256-compatible value as a 32-byte ABI word. */
export function quantityToWord(value: QuantityInput, field: string): Uint8Array {
  const n = parseQuantity(value, field);
  if (n < 0n || n >= 1n << 256n) {
    throw new Error(`${field} does not fit uint256`);
  }
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Right-pad dynamic ABI bytes to a 32-byte boundary. */
function padRight32(bytes: Uint8Array): Uint8Array {
  const len = Math.ceil(bytes.length / 32) * 32;
  const out = new Uint8Array(len);
  out.set(bytes);
  return out;
}

/** ABI-encode a Solidity string as length-prefixed dynamic bytes. */
function abiEncodeString(value: string): Uint8Array {
  return abiEncodeBytes(new TextEncoder().encode(value));
}

/** ABI-encode Solidity bytes as length-prefixed dynamic bytes. */
function abiEncodeBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes(quantityToWord(bytes.length, "bytes.length"), padRight32(bytes));
}

/**
 * ABI-encode a RelayAllocatorV2 WithdrawRequest as a single tuple argument in
 * the canonical field order, ready to be keccak256-hashed.
 *
 * The 9 fields are emitted in this order, matching the on-chain struct layout:
 *
 *   0. chainId         (string,  dynamic)
 *   1. depository      (bytes,   dynamic)
 *   2. currency        (bytes,   dynamic)
 *   3. amount          (uint256, static)
 *   4. spenderChainId  (string,  dynamic)
 *   5. spender         (bytes,   dynamic)
 *   6. receiver        (bytes,   dynamic)
 *   7. data            (bytes,   dynamic)
 *   8. nonce           (bytes32, static)
 *
 * Dynamic fields contribute an offset to the head and their length-prefixed
 * payload to the tail; static fields go directly in the head.
 */
function abiEncodeWithdrawRequest(req: WithdrawRequest): Uint8Array {
  const dynamicParts: Array<Uint8Array | null> = [
    abiEncodeString(req.chainId),
    abiEncodeBytes(hexToBytes(req.depository, "depository")),
    abiEncodeBytes(hexToBytes(req.currency, "currency")),
    null, // index 3 is the inline `amount`
    abiEncodeString(req.spenderChainId),
    abiEncodeBytes(hexToBytes(req.spender, "spender")),
    abiEncodeBytes(hexToBytes(req.receiver, "receiver")),
    abiEncodeBytes(hexToBytes(req.data, "data")),
    null, // index 8 is the inline `nonce`
  ];
  const nonce = hexToBytes(req.nonce, "nonce");
  if (nonce.length !== 32) {
    throw new Error("withdraw request nonce must be exactly 32 bytes");
  }

  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let offset = 32 * 9; // 9 head slots before the dynamic payloads start
  for (let i = 0; i < 9; i++) {
    if (i === 3) {
      head.push(quantityToWord(req.amount, "amount"));
    } else if (i === 8) {
      head.push(nonce);
    } else {
      const part = dynamicParts[i];
      if (!part) {
        throw new Error(`missing ABI dynamic part at index ${i}`);
      }
      head.push(quantityToWord(offset, "offset"));
      tail.push(part);
      offset += part.length;
    }
  }

  const tupleBody = concatBytes(...head, ...tail);
  // The outer encoding is `abi.encode(tuple)`: 32-byte offset (=0x20) then the tuple body.
  return concatBytes(quantityToWord(32, "tupleOffset"), tupleBody);
}

/** Compute keccak256(abi.encode(withdrawRequest)). */
export function computeWithdrawRequestHash(req: WithdrawRequest): Uint8Array {
  return keccak(abiEncodeWithdrawRequest(req));
}
