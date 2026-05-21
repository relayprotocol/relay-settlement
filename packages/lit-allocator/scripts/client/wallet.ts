#!/usr/bin/env tsx
/**
 * Invoke the `wallet` Lit Action and print the derived VM-specific wallet
 * address for a PKP.
 *
 * Usage:
 *   tsx scripts/client/wallet.ts \
 *     --env <name> \
 *     --usage-api-key <key> \
 *     --pkp-id <pkp-address> \
 *     --vm-type <ethereum-vm | solana-vm>
 */

import { VM_TYPES, loadEnvironment, parseEnvArg, type VmType } from "../env.js";
import { CHIPOTLE_API_BASE_URL, executeLitAction } from "./index.js";

const usage =
  "Usage:\n" +
  "  tsx scripts/client/wallet.ts --env <name> --usage-api-key <key> --pkp-id <address> --vm-type <ethereum-vm|solana-vm>";

function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const { envName, rest: args } = parseEnvArg(process.argv.slice(2));
if (!envName) {
  console.error(`Missing --env <name>.\n\n${usage}`);
  process.exit(1);
}

const apiKey = getOption(args, "--usage-api-key");
const pkpId = getOption(args, "--pkp-id");
const vmTypeArg = getOption(args, "--vm-type");
const missing: string[] = [];
if (!apiKey) {
  missing.push("--usage-api-key <key>");
}
if (!pkpId) {
  missing.push("--pkp-id <address>");
}
if (!vmTypeArg) {
  missing.push("--vm-type <ethereum-vm|solana-vm>");
}
if (missing.length > 0 || !apiKey || !pkpId || !vmTypeArg) {
  console.error(`Missing ${missing.join(", ")}.\n\n${usage}`);
  process.exit(1);
}

if (!(VM_TYPES as readonly string[]).includes(vmTypeArg)) {
  console.error(`unsupported --vm-type: ${vmTypeArg}. Supported: ${VM_TYPES.join(", ")}`);
  process.exit(1);
}
const vmType = vmTypeArg as VmType;

const env = loadEnvironment(envName);
const result = await executeLitAction(
  { apiBaseUrl: CHIPOTLE_API_BASE_URL, apiKey, pkpId, envName: env.name },
  vmType,
  { action: "wallet" },
);

console.log(JSON.stringify(result, null, 2));
