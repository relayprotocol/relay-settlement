#!/usr/bin/env tsx
/**
 * Idempotent Chipotle setup for the allocator Lit Actions.
 *
 * Two backends are supported, picked via `--mode`. Both modes use
 * `--account-api-key` as the sole account identifier:
 *
 *   --mode api-key
 *     Managed (API-mode) accounts. All admin writes go through the Chipotle
 *     REST API with `X-Api-Key: <account-api-key>`.
 *
 *   --mode chain-secured
 *     Wallet-owned accounts. Reads go through the AccountConfig contract on
 *     Base (keyed by `keccak256(toUtf8Bytes(accountApiKey))`) and writes are
 *     wallet-signed transactions sent from the admin wallet. Layers
 *     `--private-key` on top of `--account-api-key`. The Base RPC URL and
 *     AccountConfig contract address are defined in the shared setup backend
 *     in `@relay-protocol/lit-helpers`.
 *
 * Each step checks whether the underlying resource already exists and skips
 * creation when so. PKP selection is explicit: pass `--create-pkp` to mint a
 * fresh PKP or `--pkp-id <address>` to reuse an existing one.
 *
 * Usage:
 *   tsx scripts/setup.ts --env <name> --mode api-key       --account-api-key <key> (--create-pkp | --pkp-id <address>) [--dry-run]
 *   tsx scripts/setup.ts --env <name> --mode chain-secured --account-api-key <key> --private-key 0x... (--create-pkp | --pkp-id <address>) [--dry-run]
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  VM_TYPES,
  actionBasenameForVm,
  loadEnvironment,
  parseEnvArg,
  type AllocatorEnvironmentName,
  type VmType,
} from "./env.js";
import {
  createApiKeyBackend,
  createChainSecuredBackend,
  type SetupBackend,
  type SetupMode,
} from "@relay-protocol/lit-helpers/setup";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Human-readable Chipotle action description per VM. */
const ACTION_DESCRIPTIONS: Record<VmType, string> = {
  "ethereum-vm": "Lit Allocator Ethereum signing action",
  "bitcoin-vm": "Lit Allocator Bitcoin signing action",
  "tron-vm": "Lit Allocator Tron signing action",
  "solana-vm": "Lit Allocator Solana signing action",
  "ton-vm": "Lit Allocator TON signing action",
  "hyperliquid-vm": "Lit Allocator Hyperliquid signing action",
  "lighter-vm": "Lit Allocator Lighter signing action",
};

/** Environment variable name carrying each VM's deployed action CID. */
const ACTION_CID_ENV_VARS: Record<VmType, string> = {
  "ethereum-vm": "LIT_ETHEREUM_ACTION_CID",
  "bitcoin-vm": "LIT_BITCOIN_ACTION_CID",
  "tron-vm": "LIT_TRON_ACTION_CID",
  "solana-vm": "LIT_SOLANA_ACTION_CID",
  "ton-vm": "LIT_TON_ACTION_CID",
  "hyperliquid-vm": "LIT_HYPERLIQUID_ACTION_CID",
  "lighter-vm": "LIT_LIGHTER_ACTION_CID",
};

// ─── Shared script utilities ─────────────────────────────────────────────────

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1) {
    return args[idx + 1];
  }
  const prefix = `${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** Read the bundled action file from disk for a (env, vm) pair. */
function loadBundledActionFile(envName: AllocatorEnvironmentName, vmType: VmType): string {
  const basename = actionBasenameForVm(vmType);
  const candidates = [
    resolve(__dirname, "../actions", envName, `${basename}.js`),
    resolve(__dirname, "../dist/actions", envName, `${basename}.js`),
    resolve(process.cwd(), "dist/actions", envName, `${basename}.js`),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
  }
  throw new Error(
    `bundled ${vmType} action not found for ${envName}. ` +
      `Run \`npm run bundle:actions -- --env ${envName}\` first.`,
  );
}

/** Compute keccak256(cid) as a uint256, matching the on-chain registry key. */
function hashCidToBigInt(cid: string): bigint {
  const hash = keccak_256(new TextEncoder().encode(cid));
  let n = 0n;
  for (const b of hash) {
    n = (n << 8n) + BigInt(b);
  }
  return n;
}

/** Format a uint256 as a 0x-prefixed, zero-padded 64-hex-char string. */
function formatHash(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/**
 * Compute the IPFS CID a piece of action JS would resolve to via the Chipotle
 * `/get_lit_action_ipfs_id` helper. Read-only, no auth required, so we go
 * directly to the REST API regardless of which write backend is in use.
 */
async function getLitActionIpfsCid(code: string): Promise<string> {
  const res = await fetch("https://api.chipotle.litprotocol.com/core/v1/get_lit_action_ipfs_id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(code),
  });
  if (!res.ok) {
    throw new Error(`get_lit_action_ipfs_id failed (${res.status}): ${await res.text()}`);
  }
  return ((await res.json()) as string).replace(/"/g, "");
}

// ─── Backend selection ───────────────────────────────────────────────────────

/** Build the backend the user asked for, validating mode-specific args. */
function buildBackend(args: string[]): SetupBackend {
  const mode = getOption(args, "--mode") as SetupMode | undefined;
  if (mode !== "api-key" && mode !== "chain-secured") {
    throw new Error("setup requires --mode api-key or --mode chain-secured");
  }

  const accountApiKey = getOption(args, "--account-api-key");
  if (!accountApiKey) {
    throw new Error("setup requires --account-api-key <key>");
  }

  if (mode === "api-key") {
    return createApiKeyBackend(accountApiKey);
  }

  const privateKey = getOption(args, "--private-key");
  if (!privateKey) {
    throw new Error("--mode chain-secured requires --private-key <hex>");
  }
  return createChainSecuredBackend({
    privateKey,
    accountApiKey,
    pkpName: "Allocator PKP",
    pkpDescription: "Lit Allocator PKP",
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const USAGE =
  "Usage:\n" +
  "  tsx scripts/setup.ts --env <name> --mode api-key       --account-api-key <key> (--create-pkp | --pkp-id <address>) [--dry-run]\n" +
  "  tsx scripts/setup.ts --env <name> --mode chain-secured --account-api-key <key> --private-key 0x... (--create-pkp | --pkp-id <address>) [--dry-run]";

async function main() {
  const { envName, rest: args } = parseEnvArg(process.argv.slice(2));
  if (!envName) {
    console.error(`Missing --env <name>.\n\n${USAGE}`);
    process.exit(1);
  }

  const env = loadEnvironment(envName);

  const groupName = `allocator-${env.name}`;
  const usageKeyName = `allocator-${env.name}-usage-key`;
  const actionNameForVm = (vm: VmType) => `allocator-${env.name}-action-${vm}`;
  const actionDescriptionForVm = (vm: VmType) => ACTION_DESCRIPTIONS[vm];

  const dryRun = args.includes("--dry-run");
  const createPkpFlag = args.includes("--create-pkp");
  const providedPkpId = getOption(args, "--pkp-id")?.trim();
  if (createPkpFlag === Boolean(providedPkpId)) {
    console.error("setup requires exactly one of --create-pkp or --pkp-id <address>.\n\n" + USAGE);
    process.exit(1);
  }

  let backend: SetupBackend;
  try {
    backend = buildBackend(args);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    process.exit(1);
  }

  console.log(`🔥 Lit Allocator Setup (idempotent${dryRun ? ", dry run" : ""})`);
  console.log(`   Environment:  ${env.name}`);
  console.log(`   Mode:         ${backend.mode}`);
  console.log(`   Dry run:      ${dryRun ? "yes — no writes will be performed" : "no"}`);
  console.log(`   Allocator:    ${env.allocatorAddress}`);
  console.log(`   Hub chain id: ${env.hubEvmChainId}`);
  console.log();

  // ── 1. Resolve PKP wallet ───────────────────────────────────────────────
  let pkpId: string;
  if (providedPkpId) {
    console.log(`1. Reusing PKP from --pkp-id: ${providedPkpId}`);
    const wallets = await backend.listPkps();
    const existing = wallets.find(
      (w) => w.walletAddress.toLowerCase() === providedPkpId.toLowerCase(),
    );
    if (!existing) {
      throw new Error(`--pkp-id not found in account wallets: ${providedPkpId}`);
    }
    pkpId = existing.walletAddress;
    console.log(`   ✓ Exists — using account wallet: ${pkpId}`);
  } else if (dryRun) {
    pkpId = "<new-pkp-wallet>";
    console.log("1. Would create a fresh allocator PKP wallet");
  } else {
    console.log("1. Creating a fresh allocator PKP wallet...");
    const created = await backend.createPkp();
    pkpId = created.walletAddress;
    console.log(`   ✓ Wallet created: ${pkpId}`);
  }
  console.log();

  // ── 2. Ensure group exists ──────────────────────────────────────────────
  console.log("2. Checking for existing group...");
  const groups = await backend.listGroups();
  let groupId = groups.find((g) => g.name === groupName)?.id;

  if (groupId !== undefined) {
    console.log(`   ✓ Exists — using group: "${groupName}" (id=${groupId})`);
  } else if (dryRun) {
    console.log(`   Would create group "${groupName}"`);
  } else {
    console.log(`   Creating group "${groupName}"...`);
    groupId = await backend.addGroup(groupName, "Lit Allocator signing group");
    console.log(`   ✓ Group created: id=${groupId}`);
  }
  const requireGroupId = (): bigint => {
    if (groupId === undefined) {
      throw new Error(
        `group "${groupName}" does not exist yet; rerun without --dry-run to create it`,
      );
    }
    return groupId;
  };
  console.log();

  // ── 3. Ensure PKP is in the group ───────────────────────────────────────
  console.log("3. Checking if PKP is in group...");
  const walletsInGroup = groupId !== undefined ? await backend.listPkpsInGroup(groupId) : [];
  const pkpInGroup = walletsInGroup.some(
    (w) => w.walletAddress.toLowerCase() === pkpId.toLowerCase(),
  );
  if (pkpInGroup) {
    console.log("   ✓ Exists — PKP already in group");
  } else if (dryRun) {
    console.log(
      `   Would add ${providedPkpId ? `PKP ${pkpId}` : "the newly created PKP"} to group "${groupName}"`,
    );
  } else {
    console.log("   Adding PKP to group...");
    await backend.addPkpToGroup(requireGroupId(), pkpId);
    console.log("   ✓ PKP added to group");
  }
  console.log();

  // ── 4. Register the Lit Actions in the group ────────────────────────────
  console.log("4. Registering Lit Actions in group...");

  const existingActions = await backend.listActions();
  console.log(`   account has ${existingActions.length} action(s) before sync`);

  // Compute target CIDs/hashes for every VM up front.
  const targetCids = new Map<VmType, { cid: string; actionHash: bigint }>();
  for (const vmType of VM_TYPES) {
    const code = loadBundledActionFile(env.name, vmType);
    const cid = await getLitActionIpfsCid(code);
    targetCids.set(vmType, { cid, actionHash: hashCidToBigInt(cid) });
    console.log(`   ${vmType} target CID: ${cid} (hash=${formatHash(hashCidToBigInt(cid))})`);
  }
  const targetHashes = new Set([...targetCids.values()].map((t) => t.actionHash));

  // Sweep stale entries: only actions belonging to a VM the current code
  // knows about whose hash no longer matches that VM's target CID. We match
  // on the exact per-VM action names so that actions for VMs introduced on
  // other branches (e.g. a `bitcoin-vm` action) are left untouched rather
  // than pruned just for sharing the `allocator-${env.name}-` prefix.
  const managedActionNames = new Set(VM_TYPES.map((vm) => actionNameForVm(vm)));
  const stale: typeof existingActions = existingActions.filter(
    (a) =>
      a.name !== undefined && managedActionNames.has(a.name) && !targetHashes.has(a.actionHash),
  );

  if (stale.length === 0) {
    console.log("   no stale action registrations to prune");
  }
  for (const a of stale) {
    console.log(
      `   ${dryRun ? "Would prune" : "pruning"} stale action: name=${a.name ?? "<unnamed>"} hash=${formatHash(a.actionHash)}`,
    );
    if (!dryRun) {
      await backend.removeActionFromGroup(requireGroupId(), a.actionHash);
      await backend.removeAction(a.actionHash);
    }
  }

  // Register / refresh the canonical actions and attach them to the group.
  for (const vmType of VM_TYPES) {
    const { cid, actionHash } = targetCids.get(vmType)!;
    const matching = existingActions.find((a) => a.actionHash === actionHash);

    if (matching) {
      console.log(`   ✓ ${vmType}: action already registered with this CID`);
    } else if (dryRun) {
      console.log(`   Would register ${vmType} action in account: ${actionNameForVm(vmType)}`);
    } else {
      await backend.addAction(actionNameForVm(vmType), actionDescriptionForVm(vmType), cid);
      console.log(`   ✓ ${vmType}: action registered in account`);
    }

    if (dryRun) {
      console.log(`   Would attach ${vmType} action to group "${groupName}"`);
    } else {
      await backend.addActionToGroup(requireGroupId(), cid);
      console.log(`   ✓ ${vmType}: action attached to group`);
    }
  }

  // Sync group permissions in one go so the permitted set never goes empty.
  console.log(`   ${dryRun ? "Would sync" : "Syncing"} group permissions...`);
  const permittedPkpIds = Array.from(
    new Set([...walletsInGroup.map((w) => w.walletAddress), pkpId]),
  );
  if (dryRun) {
    console.log(`   Would set permitted PKPs: ${permittedPkpIds.join(", ")}`);
    console.log(
      `   Would set permitted action hashes: ${[...targetCids.values()]
        .map((t) => formatHash(t.actionHash))
        .join(", ")}`,
    );
  } else {
    await backend.updateGroup(requireGroupId(), {
      name: groupName,
      description: "Lit Allocator signing group",
      pkpIdsPermitted: permittedPkpIds,
      cidHashesPermitted: [...targetCids.values()].map((t) => t.actionHash),
    });
    console.log("   ✓ Group permissions synced");
  }
  console.log();

  // ── 5. Ensure usage API key exists ──────────────────────────────────────
  console.log("5. Checking for existing usage API key...");
  const existingKeys = await backend.listUsageApiKeys();
  const existing = existingKeys.find((k) => k.name === usageKeyName);

  let usageApiKeyValue: string | undefined;
  if (existing) {
    console.log(`   ✓ Exists — usage key "${usageKeyName}" already exists`);
    console.log("   ⚠️  The key value was shown only at creation time. Delete and");
    console.log("      re-run setup to mint a new one if you lost the original.");
  } else if (dryRun) {
    console.log(
      `   Would create usage API key "${usageKeyName}" with execute access to group "${groupName}"`,
    );
  } else {
    console.log(`   Creating usage API key "${usageKeyName}"...`);
    usageApiKeyValue = await backend.createUsageApiKey(
      usageKeyName,
      "Usage key for Lit Allocator",
      [requireGroupId()],
    );
    console.log("   ✓ Usage API key created");
    console.log(`   ⚠️  SAVE THIS NOW — it won't be shown again: ${usageApiKeyValue}`);
  }
  console.log();

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════");
  console.log(
    `  ${
      dryRun
        ? "Dry run complete — no changes were made. Target environment values:"
        : "Setup complete! Add these to your environment:"
    }`,
  );
  console.log("═══════════════════════════════════════════════════════");
  console.log();
  console.log(
    `  export LIT_API_KEY="${usageApiKeyValue ?? "<your-previously-saved-usage-api-key>"}"`,
  );
  console.log(`  export LIT_PKP_ID="${pkpId}"`);
  for (const vmType of VM_TYPES) {
    const { cid } = targetCids.get(vmType)!;
    console.log(`  export ${ACTION_CID_ENV_VARS[vmType]}="${cid}"`);
  }
  console.log();
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
