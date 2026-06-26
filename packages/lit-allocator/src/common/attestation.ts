/**
 * Verify a Relay oracle `WithdrawRequestAttestation` inside the Lit Action.
 *
 * The oracle attests — via an EIP-712 signature — that for a given withdraw
 * request the allocator contract emits a specific set of hashes that should
 * be signed. The Lit Action verifies that signature against the bundle-time
 * allowlist before producing any signatures, so a single rogue oracle (or a
 * caller-fabricated attestation) can't unlock the PKP.
 */

import { addr, verifyTyped } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/+esm";
import { computeWithdrawRequestHash } from "./abi.js";
import { bytesToHex, expectLength, hexToBytes } from "./bytes.js";
import type { WithdrawRequest, WithdrawRequestAttestation } from "./types.js";

/**
 * EIP-712 type definitions for the `WithdrawRequest` primary type the oracle
 * signs. The field order is part of the type hash, so changes here must be
 * coordinated with the oracle.
 */
const ATTESTATION_EIP712_TYPES = {
  WithdrawRequest: [
    { name: "chainId", type: "uint256" },
    { name: "allocator", type: "address" },
    { name: "withdrawRequestHash", type: "bytes32" },
    { name: "hashesToSign", type: "bytes32[]" },
  ],
} as const;

/** Build the EIP-712 typed data object for a WithdrawRequestAttestation. */
function buildAttestationTypedData(
  attestation: WithdrawRequestAttestation,
  withdrawRequestHashBytes: Uint8Array,
  hashesToSignBytes: Uint8Array[],
) {
  return {
    types: ATTESTATION_EIP712_TYPES,
    primaryType: "WithdrawRequest" as const,
    domain: {
      name: "WithdrawRequest",
      version: "1",
      chainId: attestation.chainId,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    message: {
      chainId: BigInt(attestation.chainId),
      allocator: attestation.allocator,
      withdrawRequestHash: withdrawRequestHashBytes,
      hashesToSign: hashesToSignBytes,
    },
  };
}

/** Validate and EIP-55-checksum an Ethereum address. Throws on wrong length. */
function normalizeAddress(address: string, field: string): string {
  return addr.addChecksum(`0x${bytesToHex(expectLength(hexToBytes(address, field), 20, field))}`);
}

/**
 * Verify a withdraw request attestation signed by allowlisted oracles.
 *
 * Checks that:
 * - chainId and allocator match the bundle-time config
 * - withdrawRequestHash matches the locally computed hash
 * - hashesToSign is non-empty
 * - at least oracleSignatureThreshold distinct allowlisted oracles signed
 *
 * Returns the parsed withdrawRequestHash and hashesToSign byte arrays so the
 * caller can sign each hash with the derived VM key.
 */
export function verifyWithdrawRequestAttestation(
  withdrawRequest: WithdrawRequest,
  attestation: WithdrawRequestAttestation,
  allocatorAddress: string,
  hubEvmChainId: number,
  allowedOracles: string[],
  oracleSignatureThreshold: number,
): { withdrawRequestHash: Uint8Array; hashesToSign: Uint8Array[] } {
  if (attestation.chainId !== hubEvmChainId) {
    throw new Error(
      `attestation chainId mismatch: expected=${hubEvmChainId}, provided=${attestation.chainId}`,
    );
  }

  const expectedAllocator = normalizeAddress(allocatorAddress, "allocatorAddress");
  const providedAllocator = normalizeAddress(attestation.allocator, "attestation.allocator");
  if (expectedAllocator !== providedAllocator) {
    throw new Error(
      `attestation allocator mismatch: expected=${expectedAllocator}, provided=${providedAllocator}`,
    );
  }

  const expectedHash = computeWithdrawRequestHash(withdrawRequest);
  const expectedHashHex = `0x${bytesToHex(expectedHash)}`;
  if (attestation.withdrawRequestHash.toLowerCase() !== expectedHashHex.toLowerCase()) {
    throw new Error(
      `attestation withdrawRequestHash mismatch: expected=${expectedHashHex}, provided=${attestation.withdrawRequestHash}`,
    );
  }

  if (!Array.isArray(attestation.hashesToSign) || attestation.hashesToSign.length === 0) {
    throw new Error("attestation hashesToSign must be a non-empty array");
  }
  const hashesToSignBytes = attestation.hashesToSign.map((h, i) =>
    expectLength(
      hexToBytes(h, `attestation.hashesToSign[${i}]`),
      32,
      `attestation.hashesToSign[${i}]`,
    ),
  );

  const typedData = buildAttestationTypedData(attestation, expectedHash, hashesToSignBytes);
  const allowed = new Set(
    allowedOracles.map((o, i) => normalizeAddress(o, `allowedOracles[${i}]`)),
  );
  const verified = new Set<string>();

  for (const sig of attestation.signatures) {
    const oracle = normalizeAddress(sig.oracleSigner, "attestation.signatures[].oracleSigner");
    if (!allowed.has(oracle)) {
      throw new Error(`attestation oracle is not allowlisted: ${sig.oracleSigner}`);
    }
    if (!verifyTyped(sig.signature, typedData, oracle)) {
      throw new Error(`attestation signature mismatch for oracle ${sig.oracleSigner}`);
    }
    verified.add(oracle);
  }

  if (verified.size < oracleSignatureThreshold) {
    throw new Error(
      `attestation signature threshold not met: required=${oracleSignatureThreshold}, verified=${verified.size}`,
    );
  }

  return { withdrawRequestHash: expectedHash, hashesToSign: hashesToSignBytes };
}
