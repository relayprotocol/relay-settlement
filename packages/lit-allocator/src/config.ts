/**
 * Build-time configuration constants for the Lit Action bundle.
 *
 * These `__NAME__` placeholders are string-replaced at bundle time by the
 * builder (one bundle per allocator environment). Compiling against this
 * file directly is not useful — the values only resolve once the action has
 * been bundled with `define`-style substitutions.
 */
declare const __ALLOCATOR_ADDRESS__: string;
declare const __HUB_EVM_CHAIN_ID__: string;
declare const __ALLOWED_ORACLES__: string;
declare const __ORACLE_SIGNATURE_THRESHOLD__: string;

/** Allocator contract address on the hub chain. */
export const ALLOCATOR_ADDRESS = __ALLOCATOR_ADDRESS__;
/** Hub EVM chain ID that oracles and proofs must reference. */
export const HUB_EVM_CHAIN_ID = Number.parseInt(__HUB_EVM_CHAIN_ID__, 10);
/** Allowlisted oracle addresses whose attestation signatures are accepted. */
export const ALLOWED_ORACLES = JSON.parse(__ALLOWED_ORACLES__) as string[];
/** Minimum number of distinct allowlisted oracle signatures required. */
export const ORACLE_SIGNATURE_THRESHOLD = Number.parseInt(__ORACLE_SIGNATURE_THRESHOLD__, 10);
