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
 *     AccountConfig contract address are hardcoded in
 *     `scripts/setup/backend-chain-secured.ts` — edit them there to target a
 *     different deployment.
 *
 * Each step checks whether the underlying resource already exists and skips
 * creation when so. PKP selection is explicit: pass `--create-pkp` to mint a
 * fresh PKP or `--pkp-id <address>` to reuse an existing one.
 *
 * Usage:
 *   tsx scripts/setup.ts --env <name> --mode api-key       --account-api-key <key> (--create-pkp | --pkp-id <address>)
 *   tsx scripts/setup.ts --env <name> --mode chain-secured --account-api-key <key> --private-key 0x... (--create-pkp | --pkp-id <address>)
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
import type { SetupBackend, SetupMode } from "./setup/backend.js";
import { createApiKeyBackend } from "./setup/backend-api-key.js";
import { createChainSecuredBackend } from "./setup/backend-chain-secured.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  return createChainSecuredBackend({ privateKey, accountApiKey });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const USAGE =
  "Usage:\n" +
  "  tsx scripts/setup.ts --env <name> --mode api-key       --account-api-key <key> (--create-pkp | --pkp-id <address>)\n" +
  "  tsx scripts/setup.ts --env <name> --mode chain-secured --account-api-key <key> --private-key 0x... (--create-pkp | --pkp-id <address>)";

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
  const actionDescriptionForVm = (vm: VmType) =>
    vm === "ethereum-vm"
      ? "Lit Allocator Ethereum signing action"
      : "Lit Allocator Solana signing action";

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

  console.log("🔥 Lit Allocator Setup (idempotent)");
  console.log(`   Environment:  ${env.name}`);
  console.log(`   Mode:         ${backend.mode}`);
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
    console.log(`   ✓ Using existing wallet: ${pkpId}`);
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
    console.log(`   ✓ Skipped — using existing group: "${groupName}" (id=${groupId})`);
  } else {
    console.log(`   Creating group "${groupName}"...`);
    groupId = await backend.addGroup(groupName, "Lit Allocator signing group");
    console.log(`   ✓ Group created: id=${groupId}`);
  }
  console.log();

  // ── 3. Ensure PKP is in the group ───────────────────────────────────────
  console.log("3. Checking if PKP is in group...");
  const walletsInGroup = await backend.listPkpsInGroup(groupId);
  const pkpInGroup = walletsInGroup.some(
    (w) => w.walletAddress.toLowerCase() === pkpId.toLowerCase(),
  );
  if (pkpInGroup) {
    console.log("   ✓ Skipped — PKP already in group");
  } else {
    console.log("   Adding PKP to group...");
    await backend.addPkpToGroup(groupId, pkpId);
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

  // Sweep stale entries: actions named `allocator-${env.name}-*` whose hash
  // doesn't match any current target.
  const stalePrefix = `allocator-${env.name}-`;
  const stale: typeof existingActions = existingActions.filter(
    (a) =>
      a.name !== undefined && a.name.startsWith(stalePrefix) && !targetHashes.has(a.actionHash),
  );

  if (stale.length === 0) {
    console.log(`   no stale action registrations to prune (prefix="${stalePrefix}")`);
  }
  for (const a of stale) {
    console.log(
      `   pruning stale action: name=${a.name ?? "<unnamed>"} hash=${formatHash(a.actionHash)}`,
    );
    await backend.removeActionFromGroup(groupId, a.actionHash);
    await backend.removeAction(a.actionHash);
  }

  // Register / refresh the canonical actions and attach them to the group.
  for (const vmType of VM_TYPES) {
    const { cid, actionHash } = targetCids.get(vmType)!;
    const matching = existingActions.find((a) => a.actionHash === actionHash);

    if (matching) {
      console.log(`   ✓ ${vmType}: action already registered with this CID`);
    } else {
      await backend.addAction(actionNameForVm(vmType), actionDescriptionForVm(vmType), cid);
      console.log(`   ✓ ${vmType}: action registered in account`);
    }

    await backend.addActionToGroup(groupId, cid);
    console.log(`   ✓ ${vmType}: action attached to group`);
  }

  // Sync group permissions in one go so the permitted set never goes empty.
  console.log("   Syncing group permissions...");
  const permittedPkpIds = Array.from(
    new Set([...walletsInGroup.map((w) => w.walletAddress), pkpId]),
  );
  await backend.updateGroup(groupId, {
    name: groupName,
    description: "Lit Allocator signing group",
    pkpIdsPermitted: permittedPkpIds,
    cidHashesPermitted: [...targetCids.values()].map((t) => t.actionHash),
  });
  console.log("   ✓ Group permissions synced");
  console.log();

  // ── 5. Ensure usage API key exists ──────────────────────────────────────
  console.log("5. Checking for existing usage API key...");
  const existingKeys = await backend.listUsageApiKeys();
  const existing = existingKeys.find((k) => k.name === usageKeyName);

  let usageApiKeyValue: string | undefined;
  if (existing) {
    console.log(`   ✓ Skipped — usage key "${usageKeyName}" already exists`);
    console.log("   ⚠️  The key value was shown only at creation time. Delete and");
    console.log("      re-run setup to mint a new one if you lost the original.");
  } else {
    console.log(`   Creating usage API key "${usageKeyName}"...`);
    usageApiKeyValue = await backend.createUsageApiKey(
      usageKeyName,
      "Usage key for Lit Allocator",
      [groupId],
    );
    console.log("   ✓ Usage API key created");
    console.log(`   ⚠️  SAVE THIS NOW — it won't be shown again: ${usageApiKeyValue}`);
  }
  console.log();

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Setup complete! Add these to your environment:");
  console.log("═══════════════════════════════════════════════════════");
  console.log();
  console.log(
    `  export LIT_API_KEY="${usageApiKeyValue ?? "<your-previously-saved-usage-api-key>"}"`,
  );
  console.log(`  export LIT_PKP_ID="${pkpId}"`);
  for (const vmType of VM_TYPES) {
    const { cid } = targetCids.get(vmType)!;
    const envVar = vmType === "ethereum-vm" ? "LIT_ETHEREUM_ACTION_CID" : "LIT_SOLANA_ACTION_CID";
    console.log(`  export ${envVar}="${cid}"`);
  }
  console.log();
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
