import { keccak256, toBytes, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Serialize a JSON-compatible value with deterministic key ordering at every
 * nesting level. Mirrors the encoder used inside the Lit Action so both sides
 * produce the same byte representation when hashing a sign request.
 */
function canonicalJson(value: unknown): string {
  // Mirror `JSON.stringify` semantics: object entries with an `undefined`
  // value are dropped, and standalone `undefined` is treated like `null`.
  // Keeps the helper aligned with the action-side `canonicalJson` so a
  // caller can't produce a signature that hashes a different body than the
  // JSON the action actually receives over the wire.
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}

/**
 * Recursively remove every `requestSignature` field from a value tree so the
 * canonical pre-signature representation can be hashed without including the
 * signature itself.
 */
function stripSolverRequestSignature(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSolverRequestSignature);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "requestSignature") {
        continue;
      }
      out[key] = stripSolverRequestSignature(child);
    }
    return out;
  }
  return value;
}

/**
 * Compute the keccak256 hash of the canonical JSON encoding of a sign request
 * with the `requestSignature` field stripped at every nesting level. The
 * solver signs this hash via EIP-191 personal_sign so the Lit Action can
 * verify that the request was authorized by the solver EOA.
 */
export function solverSignRequestHash(params: Record<string, unknown>): Hex {
  return keccak256(toBytes(canonicalJson(stripSolverRequestSignature(params))));
}

/**
 * Sign the canonical hash of a sign request with the solver EOA and return a
 * new params object with a `requestSignature` field appended. Convenience
 * helper used by the example scripts before calling the `sign` Lit Action.
 */
export async function addSolverRequestSignature<T extends Record<string, unknown>>(
  params: T,
  solver: PrivateKeyAccount,
): Promise<T & { requestSignature: Hex }> {
  const hash = solverSignRequestHash(params);
  return {
    ...params,
    requestSignature: await solver.signMessage({ message: { raw: hash } }),
  };
}
