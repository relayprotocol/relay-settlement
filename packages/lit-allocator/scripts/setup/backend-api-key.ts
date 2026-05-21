/**
 * API-key-mode backend.
 *
 * Every read and write goes through the Chipotle REST API with an admin
 * `X-Api-Key` header. The Chipotle server submits the on-chain transaction
 * on the account's behalf. Only works for managed (API-mode) accounts; the
 * AccountConfig contract rejects api-payer relays for ChainSecured accounts.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import type {
  ActionInfo,
  GroupInfo,
  PkpInfo,
  SetupBackend,
  UpdateGroupParams,
  UsageKeyInfo,
} from "./backend.js";

const BASE_URL = "https://api.chipotle.litprotocol.com";

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Send an authenticated Chipotle REST API request. */
async function apiCall(
  method: string,
  path: string,
  apiKey: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `${BASE_URL}/core/v1${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    throw new Error(`API ${method} ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/** Fetch every page of a paginated Chipotle list endpoint. */
async function listAll<T>(path: string, apiKey: string): Promise<T[]> {
  const results: T[] = [];
  let page = 0;
  const pageSize = 50;
  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const items = (await apiCall(
      "GET",
      `${path}${separator}page_number=${page}&page_size=${pageSize}`,
      apiKey,
    )) as T[];
    results.push(...items);
    if (items.length < pageSize) {
      break;
    }
    page++;
  }
  return results;
}

// ─── Raw response shapes ─────────────────────────────────────────────────────

interface RawWalletInfo {
  id: number;
  wallet_address: string;
  memo?: string;
}

interface RawGroupInfo {
  id: number | string;
  name: string;
  description?: string;
}

interface RawUsageKeyInfo {
  id: number | string;
  name: string;
}

interface RawUsageKeyCreateResponse {
  usage_api_key: string;
}

interface RawActionInfo {
  id: number | string;
  name: string;
  description?: string;
  ipfs_cid?: string;
  action_ipfs_cid?: string;
  cid?: string;
  hashed_cid?: string;
  cid_hash?: string;
  action_ipfs_cid_hash?: string;
  [key: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Compute `keccak256(toUtf8Bytes(cid))` as a 0x-prefixed hex string. */
function hashCid(cid: string): `0x${string}` {
  const hash = keccak_256(new TextEncoder().encode(cid));
  return `0x${Buffer.from(hash).toString("hex")}`;
}

/** Parse a 0x-prefixed or decimal id to a bigint. */
function idToBigInt(id: number | string): bigint {
  if (typeof id === "number") {
    return BigInt(id);
  }
  return BigInt(id);
}

/** Extract the IPFS CID from a raw action info, trying every known field name. */
function cidOfRaw(a: RawActionInfo): string | undefined {
  return a.action_ipfs_cid ?? a.ipfs_cid ?? a.cid;
}

/** Extract the hashed CID from a raw action info, hashing the raw CID if needed. */
function hashedCidOfRaw(a: RawActionInfo): bigint | undefined {
  const cid = cidOfRaw(a);
  if (cid) {
    return BigInt(hashCid(cid));
  }
  const explicit = a.hashed_cid ?? a.cid_hash ?? a.action_ipfs_cid_hash;
  if (explicit) {
    return BigInt(explicit);
  }
  // Some deployments key actions by their hashed CID under `id`.
  if (typeof a.id === "string" && /^0x[0-9a-fA-F]{64}$/.test(a.id)) {
    return BigInt(a.id);
  }
  return undefined;
}

/** Normalize a raw action info to the shared `ActionInfo` shape, when possible. */
function toActionInfo(a: RawActionInfo): ActionInfo | undefined {
  const actionHash = hashedCidOfRaw(a);
  if (actionHash === undefined) {
    return undefined;
  }
  return {
    actionHash,
    cid: cidOfRaw(a),
    name: a.name,
    description: a.description,
  };
}

// ─── Backend class ───────────────────────────────────────────────────────────

/** Construct an API-key-mode SetupBackend. */
export function createApiKeyBackend(apiKey: string): SetupBackend {
  return new ApiKeyBackend(apiKey);
}

class ApiKeyBackend implements SetupBackend {
  readonly mode = "api-key" as const;

  constructor(private readonly apiKey: string) {}

  // ── Reads ───────────────────────────────────────────────────────────────
  async listPkps(): Promise<PkpInfo[]> {
    const raw = await listAll<RawWalletInfo>("/list_wallets", this.apiKey);
    return raw.map((w) => ({ walletAddress: w.wallet_address, description: w.memo }));
  }

  async listGroups(): Promise<GroupInfo[]> {
    const raw = await listAll<RawGroupInfo>("/list_groups", this.apiKey);
    return raw.map((g) => ({ id: idToBigInt(g.id), name: g.name, description: g.description }));
  }

  async listActions(): Promise<ActionInfo[]> {
    const raw = await listAll<RawActionInfo>("/list_actions", this.apiKey);
    return raw.flatMap((a) => {
      const info = toActionInfo(a);
      return info ? [info] : [];
    });
  }

  async listUsageApiKeys(): Promise<UsageKeyInfo[]> {
    const raw = await listAll<RawUsageKeyInfo>("/list_api_keys", this.apiKey);
    return raw.map((k) => ({ name: k.name }));
  }

  async listPkpsInGroup(groupId: bigint): Promise<PkpInfo[]> {
    const raw = await listAll<RawWalletInfo>(
      `/list_wallets_in_group?group_id=${groupId}`,
      this.apiKey,
    );
    return raw.map((w) => ({ walletAddress: w.wallet_address, description: w.memo }));
  }

  // ── Writes ──────────────────────────────────────────────────────────────
  async createPkp(): Promise<{ walletAddress: string }> {
    const before = await this.listPkps();
    const beforeAddrs = new Set(before.map((w) => w.walletAddress.toLowerCase()));

    await apiCall("GET", "/create_wallet", this.apiKey);

    const after = await this.listPkps();
    const created = after.find((w) => !beforeAddrs.has(w.walletAddress.toLowerCase()));
    if (!created) {
      throw new Error("Failed to find newly created PKP wallet");
    }
    return { walletAddress: created.walletAddress };
  }

  async addGroup(name: string, description: string): Promise<bigint> {
    await apiCall("POST", "/add_group", this.apiKey, {
      group_name: name,
      group_description: description,
      pkp_ids_permitted: [],
      cid_hashes_permitted: [],
    });
    const groups = await this.listGroups();
    const created = groups.find((g) => g.name === name);
    if (!created) {
      throw new Error(`Failed to find group "${name}" after creation`);
    }
    return created.id;
  }

  async addPkpToGroup(groupId: bigint, pkpId: string): Promise<void> {
    await apiCall("POST", "/add_pkp_to_group", this.apiKey, {
      group_id: Number(groupId),
      pkp_id: pkpId,
    });
  }

  async addAction(name: string, description: string, cid: string): Promise<void> {
    await apiCall("POST", "/add_action", this.apiKey, {
      action_ipfs_cid: cid,
      name,
      description,
    });
  }

  async addActionToGroup(groupId: bigint, cid: string): Promise<void> {
    try {
      await apiCall("POST", "/add_action_to_group", this.apiKey, {
        group_id: Number(groupId),
        action_ipfs_cid: cid,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("409") || msg.toLowerCase().includes("already")) {
        return;
      }
      throw e;
    }
  }

  async removeActionFromGroup(groupId: bigint, actionHash: bigint): Promise<void> {
    try {
      await apiCall("POST", "/remove_action_from_group", this.apiKey, {
        group_id: Number(groupId),
        hashed_cid: `0x${actionHash.toString(16).padStart(64, "0")}`,
      });
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      console.log(`     (skipped removeActionFromGroup: ${msg})`);
    }
  }

  async removeAction(actionHash: bigint): Promise<void> {
    try {
      await apiCall("POST", "/delete_action", this.apiKey, {
        hashed_cid: `0x${actionHash.toString(16).padStart(64, "0")}`,
      });
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      console.log(`     (skipped removeAction: ${msg})`);
    }
  }

  async updateGroup(groupId: bigint, params: UpdateGroupParams): Promise<void> {
    await apiCall("POST", "/update_group", this.apiKey, {
      group_id: Number(groupId),
      name: params.name,
      description: params.description,
      pkp_ids_permitted: params.pkpIdsPermitted,
      cid_hashes_permitted: params.cidHashesPermitted.map(
        (h) => `0x${h.toString(16).padStart(64, "0")}`,
      ),
    });
  }

  async createUsageApiKey(
    name: string,
    description: string,
    executeInGroupIds: bigint[],
  ): Promise<string> {
    const created = (await apiCall("POST", "/add_usage_api_key", this.apiKey, {
      name,
      description,
      can_create_groups: false,
      can_delete_groups: false,
      can_create_pkps: false,
      manage_ipfs_ids_in_groups: [],
      add_pkp_to_groups: [],
      remove_pkp_from_groups: [],
      execute_in_groups: executeInGroupIds.map(Number),
    })) as RawUsageKeyCreateResponse;
    return created.usage_api_key;
  }
}
