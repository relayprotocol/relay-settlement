#!/usr/bin/env tsx
/**
 * Idempotent Chipotle setup for the deposit-address Lit Actions.
 *
 * Two account modes are supported, picked via `--mode`:
 *
 *   --mode api-key
 *     Managed/API-mode accounts. Admin reads and writes go through the
 *     Chipotle REST API with `X-Api-Key: <account-api-key>`.
 *
 *   --mode chain-secured
 *     Wallet-owned accounts. Reads go through the AccountConfig contract on
 *     Base (keyed by `keccak256(toUtf8Bytes(accountApiKey))`) and writes are
 *     wallet-signed transactions from `--private-key`. Alternatively, pass
 *     `--calldata` to collect contract writes for relay through an MPC/multisig
 *     owner instead of broadcasting them. PKP and usage-key minting use
 *     Chipotle's wallet-signature endpoints.
 *
 * Each step checks whether the underlying resource already exists and skips
 * creation when so. PKP selection is explicit: pass `--create-pkp` to mint a
 * fresh PKP or `--pkp-id <address>` to reuse an existing one. Exactly one of
 * the two must be supplied.
 *
 * Usage:
 *   tsx scripts/setup.ts --env <name> --mode api-key       --account-api-key <key> (--create-pkp | --pkp-id <address>) [--dry-run]
 *   tsx scripts/setup.ts --env <name> --mode chain-secured --account-api-key <key> --private-key 0x... (--create-pkp | --pkp-id <address>) [--dry-run]
 *   tsx scripts/setup.ts --env <name> --mode chain-secured --account-api-key <key> --calldata --pkp-id <address>
 *
 * `--calldata` requires an existing PKP and usage key because minting requires
 * a live admin signature.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  VM_TYPES,
  loadEnvironment,
  parseEnvArg,
  type DepositAddressEnvironmentName,
  type VmType,
} from "./env.js";
import {
  CalldataCollector,
  createApiKeyBackend,
  createChainSecuredBackend,
  printCalldataBatch,
  type SetupBackend,
  type SetupMode,
} from "@relay-protocol/lit-helpers/setup";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = "https://api.chipotle.litprotocol.com";

// ─── Shared script utilities ────────────────────────────────────────────────

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1) {
    return args[idx + 1];
  }
  const prefix = `${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** Read one bundled VM action file from disk, trying a few candidate paths. */
function loadBundledActionFile(envName: DepositAddressEnvironmentName, vmType: VmType): string {
  const filename = `${vmType}.js`;
  const candidates = [
    resolve(__dirname, "../actions", envName, filename),
    resolve(__dirname, "../dist/actions", envName, filename),
    resolve(process.cwd(), "dist/actions", envName, filename),
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
    `bundled ${vmType} action file not found for ${envName}. Run \`npm run bundle:actions -- --env ${envName}\` first.`,
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
  const res = await fetch(`${BASE_URL}/core/v1/get_lit_action_ipfs_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(code),
  });
  if (!res.ok) {
    throw new Error(`get_lit_action_ipfs_id failed (${res.status}): ${await res.text()}`);
  }
  return ((await res.json()) as string).replace(/"/g, "");
}

// ─── Backend selection ──────────────────────────────────────────────────────

/**
 * Build the backend the user asked for, validating mode-specific args. When
 * `--calldata` is set (chain-secured only), contract writes are collected on
 * the returned `collector` for relay through an MPC/multisig owner instead of
 * being broadcast, so no `--private-key` is required.
 */
function buildBackend(args: string[]): {
  backend: SetupBackend;
  collector?: CalldataCollector;
} {
  const mode = getOption(args, "--mode") as SetupMode | undefined;
  if (mode !== "api-key" && mode !== "chain-secured") {
    throw new Error("setup requires --mode api-key or --mode chain-secured");
  }

  const accountApiKey = getOption(args, "--account-api-key");
  if (!accountApiKey) {
    throw new Error("setup requires --account-api-key <key>");
  }

  const calldata = args.includes("--calldata");

  if (mode === "api-key") {
    if (calldata) {
      throw new Error("--calldata is only supported with --mode chain-secured");
    }
    return { backend: createApiKeyBackend(accountApiKey) };
  }

  if (calldata) {
    const collector = new CalldataCollector();
    return {
      backend: createChainSecuredBackend({
        accountApiKey,
        collector,
        pkpName: "Deposit Address PKP",
        pkpDescription: "Lit Deposit Address PKP",
      }),
      collector,
    };
  }

  const privateKey = getOption(args, "--private-key");
  if (!privateKey) {
    throw new Error("--mode chain-secured requires --private-key <hex> (or --calldata)");
  }
  return {
    backend: createChainSecuredBackend({
      privateKey,
      accountApiKey,
      pkpName: "Deposit Address PKP",
      pkpDescription: "Lit Deposit Address PKP",
    }),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

const USAGE =
  "Usage:\n" +
  "  tsx scripts/setup.ts --env <name> --mode api-key       --account-api-key <key> (--create-pkp | --pkp-id <address>) [--dry-run]\n" +
  "  tsx scripts/setup.ts --env <name> --mode chain-secured --account-api-key <key> --private-key 0x... (--create-pkp | --pkp-id <address>) [--dry-run]\n" +
  "  tsx scripts/setup.ts --env <name> --mode chain-secured --account-api-key <key> --calldata --pkp-id <address>\n" +
  "\n" +
  "  --calldata: emit the contract calldata to relay via the account owner (MPC/multisig)\n" +
  "              instead of broadcasting. Requires --pkp-id and an already-provisioned\n" +
  "              usage key (PKP/usage-key minting need a live admin signature).";

async function main() {
  const { envName, rest: args } = parseEnvArg(process.argv.slice(2));
  if (!envName) {
    console.error(`Missing --env <name>.\n\n${USAGE}`);
    process.exit(1);
  }

  const env = loadEnvironment(envName);

  const groupName = `deposit-address-${env.name}`;
  const usageKeyName = `deposit-address-${env.name}-usage-key`;
  const actionNamePrefix = `deposit-address-${env.name}-action-`;
  const actionNameForVm = (vmType: VmType) => `${actionNamePrefix}${vmType}`;
  const actionDescriptionForVm = (vmType: VmType) =>
    `Lit Deposit Address signing action (${vmType})`;
  const managedActionNames = new Set(VM_TYPES.map(actionNameForVm));

  const dryRun = args.includes("--dry-run");
  const calldataMode = args.includes("--calldata");
  const createPkp = args.includes("--create-pkp");
  const providedPkpId = getOption(args, "--pkp-id")?.trim();
  if (createPkp === Boolean(providedPkpId)) {
    console.error("setup requires exactly one of --create-pkp or --pkp-id <address>.\n\n" + USAGE);
    process.exit(1);
  }
  if (calldataMode && dryRun) {
    console.error("--calldata and --dry-run are mutually exclusive.\n\n" + USAGE);
    process.exit(1);
  }
  if (calldataMode && createPkp) {
    console.error(
      "--calldata cannot mint a PKP (it needs a live admin signature); pass --pkp-id <address>.\n\n" +
        USAGE,
    );
    process.exit(1);
  }

  let backend: SetupBackend;
  let collector: CalldataCollector | undefined;
  try {
    ({ backend, collector } = buildBackend(args));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    process.exit(1);
  }

  console.log(`🔥 Lit Deposit Address Setup (idempotent${dryRun ? ", dry run" : ""})`);
  console.log(`   Environment: ${env.name}`);
  console.log(`   Mode: ${backend.mode}${calldataMode ? " (calldata — no broadcast)" : ""}`);
  console.log(`   Dry run: ${dryRun ? "yes — no writes will be performed" : "no"}`);
  console.log(`   Deposit address manager: ${env.depositAddressManagerAddress}`);
  console.log(`   Hub chain id: ${env.hubEvmChainId}`);
  console.log(`   API: ${BASE_URL}`);
  console.log();

  // ── 1. Resolve PKP wallet ──────────────────────────────────────────────
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
    console.log("1. Would create a fresh deposit-address PKP wallet");
  } else {
    console.log("1. Creating a fresh deposit-address PKP wallet...");
    const created = await backend.createPkp();
    pkpId = created.walletAddress;
    console.log(`   ✓ Wallet created: ${pkpId}`);
  }
  console.log();

  // ── 2. Ensure group exists ─────────────────────────────────────────────
  console.log("2. Checking for existing group...");
  const groups = await backend.listGroups();
  // `group` stays undefined until it exists on-chain. A missing group is
  // created fully populated in step 4 with a single addGroup call, so we never
  // need to know its id up front — this is what lets calldata mode emit one
  // self-contained batch (create group + permissions) instead of two.
  let group = groups.find((g) => g.name === groupName);
  const groupExists = group !== undefined;

  if (groupExists) {
    console.log(`   ✓ Exists — using group: "${group!.name}" (id=${group!.id})`);
  } else if (dryRun) {
    console.log(`   Would create group "${groupName}" (fully populated)`);
  } else {
    console.log(`   Group "${groupName}" is missing — will create it fully populated below`);
  }
  const requireGroup = () => {
    if (!group) {
      throw new Error(`group "${groupName}" does not exist yet`);
    }
    return group;
  };
  console.log();

  // ── 3. Ensure PKP is in the group ──────────────────────────────────────
  console.log("3. Checking if PKP is in group...");
  const walletsInGroup = groupExists ? await backend.listPkpsInGroup(requireGroup().id) : [];
  // Track the group's permitted PKPs locally so writes performed during this
  // run (addPkpToGroup) are reflected without a re-read. This lets the later
  // permission-sync check skip a redundant updateGroup call for changes we have
  // already emitted individually.
  const currentPkpSet = new Set(walletsInGroup.map((w) => w.walletAddress.toLowerCase()));
  const pkpInGroup = currentPkpSet.has(pkpId.toLowerCase());

  if (!groupExists) {
    console.log("   Group missing — PKP will be included when the group is created");
  } else if (pkpInGroup) {
    console.log("   ✓ Exists — PKP already in group");
  } else if (dryRun) {
    console.log(
      `   Would add ${providedPkpId ? `PKP ${pkpId}` : "the newly created PKP"} to group "${groupName}"`,
    );
  } else {
    console.log("   Adding PKP to group...");
    await backend.addPkpToGroup(requireGroup().id, pkpId);
    currentPkpSet.add(pkpId.toLowerCase());
    console.log("   ✓ PKP added to group");
  }
  console.log();

  // ── 4. Register the Lit Actions in the group ───────────────────────────
  console.log("4. Registering per-VM Lit Actions in group...");

  const existingActions = await backend.listActions();
  console.log(`   account has ${existingActions.length} action(s) before sync`);

  // Actions already attached to the group (its permitted CID hashes) so we can
  // skip on-chain writes when everything is already in place.
  const actionsInGroup = groupExists ? await backend.listActionsInGroup(requireGroup().id) : [];
  const attachedHashes = new Set(actionsInGroup.map((a) => a.actionHash));

  // Compute target CIDs/hashes for every VM up front so group permissions can
  // be synced once against the union of all current CIDs.
  const targetCids = new Map<VmType, { cid: string; actionHash: bigint }>();
  for (const vmType of VM_TYPES) {
    const code = loadBundledActionFile(env.name, vmType);
    const cid = await getLitActionIpfsCid(code);
    const actionHash = hashCidToBigInt(cid);
    targetCids.set(vmType, { cid, actionHash });
    console.log(`   ${vmType} target CID: ${cid} (hash=${formatHash(actionHash)})`);
  }
  const targetHashes = new Set([...targetCids.values()].map((t) => t.actionHash));

  // Always sweep up stale entries on every setup pass (not only when adding a
  // new CID), otherwise stale registrations from past bundles accumulate in
  // the account. Be conservative: only actions whose name exactly matches one
  // of this environment's canonical per-VM action names are managed here. This
  // avoids deleting unrelated actions in the same Chipotle account that happen
  // to share a broader prefix such as `deposit-address-${env.name}`.
  const stale = existingActions.filter((a) => {
    return (
      a.name !== undefined && managedActionNames.has(a.name) && !targetHashes.has(a.actionHash)
    );
  });

  if (stale.length === 0) {
    console.log(
      `   no stale action registrations to prune (managed names: ${[...managedActionNames].join(", ")})`,
    );
  }
  for (const action of stale) {
    console.log(
      `   ${dryRun ? "Would prune" : "pruning"} stale action: name=${action.name ?? "<unnamed>"} hash=${formatHash(action.actionHash)}`,
    );
    if (!dryRun) {
      if (groupExists) {
        await backend.removeActionFromGroup(requireGroup().id, action.actionHash);
        attachedHashes.delete(action.actionHash);
      }
      await backend.removeAction(action.actionHash);
    }
  }

  // Register / refresh each per-VM action and attach it to the group.
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

    // Attaching to an existing group happens here; a missing group is created
    // with every action already attached below, so skip per-action writes.
    if (!groupExists) {
      continue;
    }
    if (attachedHashes.has(actionHash)) {
      console.log(`   ✓ ${vmType}: action already attached to group`);
    } else if (dryRun) {
      console.log(`   Would attach ${vmType} action to group "${groupName}"`);
    } else {
      await backend.addActionToGroup(requireGroup().id, cid);
      attachedHashes.add(actionHash);
      console.log(`   ✓ ${vmType}: action attached to group`);
    }
  }

  // The permitted sets the group should end up with.
  const permittedPkpIds = Array.from(
    new Set([...walletsInGroup.map((w) => w.walletAddress), pkpId]),
  );
  const targetActionHashes = [...targetCids.values()].map((t) => t.actionHash);

  if (!groupExists) {
    // Fresh group: create it fully populated in a single call. No id is needed,
    // so this is one self-contained transaction that also works in calldata
    // mode (where the new id can't be read back mid-batch).
    if (dryRun) {
      console.log("   Would create group fully populated:");
      console.log(`   Would set permitted PKPs: ${permittedPkpIds.join(", ")}`);
      console.log(
        `   Would set permitted action hashes: ${targetActionHashes.map(formatHash).join(", ")}`,
      );
    } else {
      console.log(`   Creating group "${groupName}" with permissions...`);
      const newId = await backend.addGroup(
        groupName,
        "Lit Deposit Address signing group",
        targetActionHashes,
        permittedPkpIds,
      );
      // In calldata mode the id is a sentinel (unreadable until relayed); leave
      // `group` undefined there so nothing downstream mistakes it for real.
      if (!calldataMode) {
        group = {
          id: newId,
          name: groupName,
          description: "Lit Deposit Address signing group",
        };
      }
      console.log("   ✓ Group created with permissions");
    }
  } else {
    // Existing group: sync only what is out of date. Because the individual
    // addPkpToGroup / addActionToGroup writes above were tracked locally, a
    // fully-synced group emits no updateGroup call.
    const pkpsInSync = permittedPkpIds.every((p) => currentPkpSet.has(p.toLowerCase()));
    const actionsSynced =
      attachedHashes.size === targetHashes.size &&
      [...targetHashes].every((h) => attachedHashes.has(h));
    const permissionsInSync = pkpsInSync && actionsSynced;

    if (permissionsInSync) {
      console.log("   ✓ Group permissions already in sync");
    } else if (dryRun) {
      console.log("   Would sync group permissions...");
      console.log(`   Would set permitted PKPs: ${permittedPkpIds.join(", ")}`);
      console.log(
        `   Would set permitted action hashes: ${targetActionHashes.map(formatHash).join(", ")}`,
      );
    } else {
      console.log("   Syncing group permissions...");
      const currentGroup = requireGroup();
      await backend.updateGroup(currentGroup.id, {
        name: currentGroup.name,
        description: currentGroup.description ?? "Lit Deposit Address signing group",
        pkpIdsPermitted: permittedPkpIds,
        cidHashesPermitted: targetActionHashes,
      });
      console.log("   ✓ Group permissions synced");
    }
  }
  console.log();

  // ── 5. Ensure usage API key exists ─────────────────────────────────────
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
  } else if (calldataMode) {
    console.log(`   ⚠️  usage key "${usageKeyName}" is missing and cannot be minted in`);
    console.log("      calldata mode (it needs a live admin signature). Mint it in");
    console.log("      broadcast mode before/after transferring ownership.");
  } else {
    console.log(`   Creating usage API key "${usageKeyName}"...`);
    usageApiKeyValue = await backend.createUsageApiKey(
      usageKeyName,
      "Usage key for Lit Deposit Address",
      [requireGroup().id],
    );
    console.log("   ✓ Usage API key created");
    console.log(`   ⚠️  SAVE THIS NOW — it won't be shown again: ${usageApiKeyValue}`);
  }
  console.log();

  // ── Calldata batch (MPC relay) ──────────────────────────────────────────
  if (collector) {
    printCalldataBatch(collector);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════");
  console.log(
    `  ${
      dryRun
        ? "Dry run complete — no changes were made. Target environment values:"
        : calldataMode
          ? "Calldata emitted above — relay it via the account owner. Environment values:"
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
    const envSuffix = vmType.replace("-", "_").toUpperCase();
    console.log(`  export LIT_DEPOSIT_ADDRESSES_ACTION_CID_${envSuffix}="${cid}"`);
  }
  console.log();
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
