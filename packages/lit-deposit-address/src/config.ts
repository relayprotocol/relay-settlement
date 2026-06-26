/**
 * Bundle-time configuration constants.
 *
 * Each `__*__` global below is a bundler-replaced string literal injected at
 * build time from one of the `environments/*.json` files. Keeping these as
 * placeholders here lets the Lit Action read them like any other constant
 * while remaining environment-agnostic in source form.
 */

declare const __DEPOSIT_ADDRESS_MANAGER_ADDRESS__: string;
declare const __HUB_EVM_CHAIN_ID__: string;
declare const __ALLOWED_ORACLES__: string;
declare const __ORACLE_SIGNATURE_THRESHOLD__: string;

/** Hub deposit-address manager contract address bound into the bundle. */
export const DEPOSIT_ADDRESS_MANAGER_ADDRESS = __DEPOSIT_ADDRESS_MANAGER_ADDRESS__;

/** Hub EVM chain id this bundle attests trigger signatures for. */
export const HUB_EVM_CHAIN_ID = Number.parseInt(__HUB_EVM_CHAIN_ID__, 10);

/** Allowlisted oracle signer addresses for trigger attestations. */
export const ALLOWED_ORACLES = JSON.parse(__ALLOWED_ORACLES__) as string[];

/** Minimum number of distinct allowlisted oracle signatures required. */
export const ORACLE_SIGNATURE_THRESHOLD = Number.parseInt(__ORACLE_SIGNATURE_THRESHOLD__, 10);
