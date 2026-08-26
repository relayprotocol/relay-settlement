#!/usr/bin/env tsx
/**
 * Create the Hedera depository account for an environment's PKP.
 *
 * Hedera accounts are created, not merely addressed. The `hedera-vm` action
 * derives a secp256k1 keypair inside the TEE, but that only yields an EVM
 * alias — the protocol needs the `shard.realm.num` entity id an account gains
 * when it is created, because `HederaVmPayloadBuilder` reads the depository's
 * account number out of a long-zero address and rejects an alias.
 *
 * So this script asks the action for the environment's public key, creates an
 * account keyed to it, and prints the resulting account id to register as the
 * depository. The key never leaves the TEE: account creation needs only the
 * public half.
 *
 * Creating explicitly rather than by transferring to the alias is deliberate.
 * An alias transfer auto-creates a *hollow* account whose key is only written
 * once it signs something, and it is unverified whether Hedera completes a
 * hollow account from a co-signer signature rather than a fee-payer one — which
 * is the depository's situation, since the submitter pays. Creating up front
 * writes the key immediately and sidesteps the question.
 *
 * Idempotent: if an account already exists for the derived alias, it reports it
 * and creates nothing.
 *
 * Usage:
 *   tsx scripts/client/create-hedera-depository.ts \
 *     --env <name> \
 *     --usage-api-key <key> \
 *     --pkp-id <pkp-address> \
 *     --operator-id <0.0.x> \
 *     --operator-key <hex or DER private key> \
 *     [--hedera-network mainnet|testnet|previewnet] \
 *     [--initial-hbar <n>] \
 *     [--max-auto-assoc <n>] \
 *     [--dry-run]
 *
 * The operator is any funded Hedera account; it pays the ~0.76 HBAR creation
 * fee and nothing more. `--initial-hbar` can be small: under the submitter-pays
 * fee model the depository never spends HBAR on transaction fees, so it needs no
 * reserve of its own.
 */

import { AccountCreateTransaction, Client, Hbar, PrivateKey, PublicKey } from "@hashgraph/sdk";

import { loadEnvironment, parseEnvArg } from "../env.js";
import { CHIPOTLE_API_BASE_URL, executeLitAction } from "./index.js";

type HederaNetwork = "mainnet" | "testnet" | "previewnet";

const MIRROR_NODES: Record<HederaNetwork, string> = {
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
  testnet: "https://testnet.mirrornode.hedera.com",
  previewnet: "https://previewnet.mirrornode.hedera.com",
};

const usage =
  "Usage:\n" +
  "  tsx scripts/client/create-hedera-depository.ts --env <name> --usage-api-key <key> " +
  "--pkp-id <address> --operator-id <0.0.x> --operator-key <key> " +
  "[--hedera-network mainnet|testnet|previewnet] [--initial-hbar <n>] [--max-auto-assoc <n>] [--dry-run]";

function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1) {
    return args[idx + 1];
  }
  const prefix = `${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/**
 * Parse an operator private key. Hedera accounts are keyed by either curve and
 * the two are indistinguishable from a bare hex string, so the curve is taken
 * from the key's own encoding when it is DER and probed otherwise.
 */
function parseOperatorKey(raw: string): PrivateKey {
  const value = raw.replace(/^0x/, "");
  // DER-encoded keys carry their own algorithm identifier.
  if (value.length > 64) {
    return PrivateKey.fromStringDer(value);
  }
  // A bare 32-byte key is ambiguous. ED25519 is the Hedera default, but an
  // account created from an EVM alias is ECDSA, and using the wrong curve
  // produces a valid-looking key whose signature the network rejects. Prefer
  // ECDSA and let the caller pass DER when they mean ED25519.
  return PrivateKey.fromStringECDSA(value);
}

const { envName, rest: args } = parseEnvArg(process.argv.slice(2));
if (!envName) {
  console.error(`Missing --env <name>.\n\n${usage}`);
  process.exit(1);
}

const apiKey = getOption(args, "--usage-api-key");
const pkpId = getOption(args, "--pkp-id");
const operatorId = getOption(args, "--operator-id");
const operatorKeyRaw = getOption(args, "--operator-key");
const dryRun = args.includes("--dry-run");
const hederaNetwork = (getOption(args, "--hedera-network") ?? "mainnet") as HederaNetwork;
const initialHbar = Number(getOption(args, "--initial-hbar") ?? 1);
// -1 requests unlimited automatic associations. The depository cannot sign its
// own TokenAssociateTransaction — its key lives in the TEE and the action only
// signs attested withdrawal payloads — so associations have to be arranged by
// whoever creates the account.
const maxAutoAssoc = Number(getOption(args, "--max-auto-assoc") ?? -1);

const missing: string[] = [];
if (!apiKey) {
  missing.push("--usage-api-key <key>");
}
if (!pkpId) {
  missing.push("--pkp-id <address>");
}
if (!dryRun && !operatorId) {
  missing.push("--operator-id <0.0.x>");
}
if (!dryRun && !operatorKeyRaw) {
  missing.push("--operator-key <key>");
}
if (missing.length > 0 || !apiKey || !pkpId) {
  console.error(`Missing ${missing.join(", ")}.\n\n${usage}`);
  process.exit(1);
}

if (!MIRROR_NODES[hederaNetwork]) {
  console.error(`unsupported --hedera-network: ${hederaNetwork}\n\n${usage}`);
  process.exit(1);
}
const mirrorNode = MIRROR_NODES[hederaNetwork];

const env = loadEnvironment(envName);

// Ask the action for this environment's Hedera identity rather than taking an
// address on the command line, so the depository can only ever be the account
// the environment's own PKP controls.
const wallet = (await executeLitAction(
  { apiBaseUrl: CHIPOTLE_API_BASE_URL, apiKey, pkpId, envName: env.name },
  "hedera-vm",
  { action: "wallet" },
)) as { vmType: string; address: string; publicKey: string };

if (wallet.vmType !== "hedera-vm" || !wallet.publicKey || !wallet.address) {
  console.error(`unexpected wallet response: ${JSON.stringify(wallet)}`);
  process.exit(1);
}

const publicKey = PublicKey.fromStringECDSA(wallet.publicKey.replace(/^0x/, ""));
const derivedAlias = `0x${publicKey.toEvmAddress()}`.toLowerCase();

// The action returns both; disagreement would mean the action and the SDK derive
// aliases differently, and the account would be created at the wrong address.
if (derivedAlias !== wallet.address.toLowerCase()) {
  console.error(
    `alias mismatch: action reported ${wallet.address} but its public key derives ${derivedAlias}`,
  );
  process.exit(1);
}

console.log("════════════════════════════════════════════════════════════════════════");
console.log("Creating Hedera depository account");
console.log(`  environment:     ${env.name}`);
console.log(`  allocator:       ${env.allocatorAddress}`);
console.log(`  pkpId:           ${pkpId}`);
console.log(`  hederaNetwork:   ${hederaNetwork}`);
console.log(`  derived alias:   ${derivedAlias}`);
console.log(`  publicKey:       ${wallet.publicKey}`);
console.log(`  operator:        ${operatorId ?? "(dry run)"}`);
console.log(`  initialBalance:  ${initialHbar} HBAR`);
console.log(`  maxAutoAssoc:    ${maxAutoAssoc}${maxAutoAssoc === -1 ? " (unlimited)" : ""}`);
console.log(`  dryRun:          ${dryRun ? "1" : "0"}`);
console.log("════════════════════════════════════════════════════════════════════════");

/** Look up an account by alias or id, returning undefined when absent. */
async function fetchAccount(idOrAlias: string): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`${mirrorNode}/api/v1/accounts/${idOrAlias}`);
  if (!res.ok) {
    return undefined;
  }
  const body = (await res.json()) as Record<string, unknown>;
  return body.account ? body : undefined;
}

const existing = await fetchAccount(derivedAlias);
if (existing) {
  console.log("==> Account already exists for this alias, creating nothing");
  console.log(`    account: ${existing.account as string}`);
  console.log(`    key:     ${JSON.stringify(existing.key)}`);
  console.log(`\nDEPOSITORY=${existing.account as string}`);
  process.exit(0);
}
console.log("==> No account for this alias yet");

if (dryRun) {
  console.log("==> DRY_RUN, nothing submitted");
  process.exit(0);
}

const client = Client.forName(hederaNetwork).setOperator(
  operatorId!,
  parseOperatorKey(operatorKeyRaw!),
);

console.log("==> Submitting AccountCreateTransaction");
let accountId: string;
let transactionId: string;
try {
  const submitted = await new AccountCreateTransaction()
    // Sets the account key AND pins the EVM alias derived from it, so the
    // account is reachable at the address the action returns. A plain `setKey`
    // would leave the alias unset.
    .setECDSAKeyWithAlias(publicKey)
    .setInitialBalance(new Hbar(initialHbar))
    .setMaxAutomaticTokenAssociations(maxAutoAssoc)
    .execute(client);

  accountId = (await submitted.getReceipt(client)).accountId!.toString();
  transactionId = submitted.transactionId.toString();
} finally {
  // The client holds open gRPC channels to every consensus node, which keep the
  // event loop alive and hang the process after the work is done.
  client.close();
}
console.log(`    tx:      ${transactionId}`);
console.log(`    account: ${accountId}`);

// Read the alias back rather than trusting the receipt: a create that failed to
// pin the alias still succeeds, and the mismatch would only surface much later
// as a withdrawal the builder refuses to build.
const created = await fetchAccount(accountId);
const createdAlias = ((created?.evm_address as string) ?? "").toLowerCase();
console.log(`    evm_address: ${createdAlias}`);

if (createdAlias !== derivedAlias) {
  console.error(
    `\nALIAS MISMATCH: expected ${derivedAlias}, got ${createdAlias}.\n` +
      `Do not register this account as the depository.`,
  );
  process.exit(1);
}

console.log("\n✓ alias matches the PKP-derived address");
console.log(`\nDEPOSITORY=${accountId}`);
