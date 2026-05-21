/**
 * Abstract setup backend.
 *
 * Each backend implements the read + write surface required by `setup.ts` for
 * a particular Chipotle account ownership model:
 *
 * - `"api-key"`: writes go through the Chipotle REST API with an admin
 *   `X-Api-Key` header. The simplest and most permissive model, but only
 *   works for managed (API-mode) accounts.
 * - `"chain-secured"`: writes go directly to the AccountConfig contract on
 *   Base, signed by the admin wallet's private key. PKP minting and usage
 *   key creation use the `*_with_signature` HTTP endpoints (which only need
 *   an EIP-712 wallet signature, no API key) plus follow-up contract calls.
 *
 * Future backends (e.g. a Gnosis Safe proposal builder) should slot in here
 * by implementing the same interface.
 */

/** Minimal PKP wallet info exposed by both backends. */
export interface PkpInfo {
  /** EVM address of the PKP wallet. */
  walletAddress: string;
  name?: string;
  description?: string;
}

/** Minimal group info exposed by both backends. */
export interface GroupInfo {
  /** On-chain group id. */
  id: bigint;
  name: string;
  description?: string;
}

/** Minimal action info exposed by both backends. */
export interface ActionInfo {
  /** keccak256(toUtf8Bytes(cid)) as a uint256 — the on-chain registry key. */
  actionHash: bigint;
  /** Raw IPFS CID, when known. */
  cid?: string;
  name?: string;
  description?: string;
}

/** Minimal usage-key info exposed by both backends. */
export interface UsageKeyInfo {
  name: string;
}

/** Permissions written by `updateGroup`. */
export interface UpdateGroupParams {
  name: string;
  description: string;
  /** Wallet addresses permitted to execute against the group. */
  pkpIdsPermitted: string[];
  /** keccak256-hashed CIDs allowed in the group. */
  cidHashesPermitted: bigint[];
}

/** The mode label for log output and CLI parsing. */
export type SetupMode = "api-key" | "chain-secured";

/** Read surface — same shape for every backend, different transport. */
export interface SetupReads {
  listPkps(): Promise<PkpInfo[]>;
  listGroups(): Promise<GroupInfo[]>;
  listActions(): Promise<ActionInfo[]>;
  listUsageApiKeys(): Promise<UsageKeyInfo[]>;
  listPkpsInGroup(groupId: bigint): Promise<PkpInfo[]>;
}

/** Write surface — same shape for every backend, different transport. */
export interface SetupWrites {
  /** Mint a fresh PKP and register it to the account. */
  createPkp(): Promise<{ walletAddress: string }>;

  /** Register a new group. Returns the new group's id. */
  addGroup(name: string, description: string): Promise<bigint>;

  /** Attach a PKP to a group. */
  addPkpToGroup(groupId: bigint, pkpId: string): Promise<void>;

  /** Register an action in the account-level registry. */
  addAction(name: string, description: string, cid: string): Promise<void>;

  /** Attach an action to a group. */
  addActionToGroup(groupId: bigint, cid: string): Promise<void>;

  /** Best-effort removal: callers must tolerate failure. */
  removeActionFromGroup(groupId: bigint, actionHash: bigint): Promise<void>;

  /** Best-effort removal: callers must tolerate failure. */
  removeAction(actionHash: bigint): Promise<void>;

  /** Replace a group's metadata and permission lists. */
  updateGroup(groupId: bigint, params: UpdateGroupParams): Promise<void>;

  /**
   * Mint a usage API key with execute permission for the given group ids.
   * Returns the secret key value (shown once).
   */
  createUsageApiKey(
    name: string,
    description: string,
    executeInGroupIds: bigint[],
  ): Promise<string>;
}

/** Combined setup-time surface. */
export interface SetupBackend extends SetupReads, SetupWrites {
  /** Human-readable mode label for log output. */
  readonly mode: SetupMode;
}
