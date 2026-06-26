#!/usr/bin/env tsx
/**
 * Unified CLI for the deposit-address Lit Action client. Dispatches on the
 * first positional argument:
 *
 *   account  Invoke the `account` Lit Action and print the publicly
 *            shareable account derivation root for a VM family.
 *
 *   wallet   Invoke the `wallet` Lit Action and print the deposit wallet
 *            derived from a set of `derivationFields` read from a JSON file.
 *
 *   derive   Reproduce the `wallet` action's output locally using only
 *            public derivation (no PKP / TEE access).
 *
 * Usage:
 *   tsx scripts/client.ts account --env <name> --usage-api-key <key> \
 *     --pkp-id <pkp-address> --vm-type <ethereum-vm|bitcoin-vm|solana-vm|hyperliquid-vm>
 *   tsx scripts/client.ts wallet  --env <name> --usage-api-key <key> \
 *     --pkp-id <pkp-address> --input <path-to-derivation-fields.json>
 *   tsx scripts/client.ts derive  --account <path> --input <path>
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironment, parseEnvArg, VM_TYPES, type VmType } from "./env.js";
import { DEFAULT_BASE_URL, executeLitAction } from "./client/index.js";
import {
  deriveDepositWallet,
  type AccountResponse,
  type DerivationFields,
} from "./client/local-derivation.js";

const USAGE = [
  "Usage:",
  "  tsx scripts/client.ts account --env <name> --usage-api-key <key> --pkp-id <address> --vm-type <vm>",
  "  tsx scripts/client.ts wallet  --env <name> --usage-api-key <key> --pkp-id <address> --input <path>",
  "  tsx scripts/client.ts derive  --account <path> --input <path>",
].join("\n");

function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1) {
    return args[idx + 1];
  }
  const prefix = `${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function assertVmType(value: string | undefined, field: string): VmType {
  if (!value || !(VM_TYPES as readonly string[]).includes(value)) {
    fail(`${field} must be one of ${VM_TYPES.join(", ")}`);
  }
  return value as VmType;
}

async function runAccount(args: string[]) {
  const { envName, rest } = parseEnvArg(args);
  if (!envName) {
    fail("Missing --env <name>");
  }
  const apiKey = getOption(rest, "--usage-api-key");
  const pkpId = getOption(rest, "--pkp-id");
  const vmType = assertVmType(getOption(rest, "--vm-type"), "--vm-type");
  if (!apiKey || !pkpId) {
    fail("Missing --usage-api-key or --pkp-id");
  }

  const env = loadEnvironment(envName);
  const result = await executeLitAction(
    { apiBaseUrl: DEFAULT_BASE_URL, apiKey, pkpId, envName: env.name, vmType },
    { action: "account", vmType },
  );
  console.log(JSON.stringify(result, null, 2));
}

async function runWallet(args: string[]) {
  const { envName, rest } = parseEnvArg(args);
  if (!envName) {
    fail("Missing --env <name>");
  }
  const apiKey = getOption(rest, "--usage-api-key");
  const pkpId = getOption(rest, "--pkp-id");
  const inputPath = getOption(rest, "--input");
  if (!apiKey || !pkpId || !inputPath) {
    fail("Missing --usage-api-key, --pkp-id, or --input");
  }

  const derivationFields = JSON.parse(readFileSync(resolve(inputPath), "utf-8")) as Record<
    string,
    unknown
  >;
  const vmType = assertVmType(derivationFields.inputVmType as string | undefined, "inputVmType");

  const env = loadEnvironment(envName);
  const result = await executeLitAction(
    { apiBaseUrl: DEFAULT_BASE_URL, apiKey, pkpId, envName: env.name, vmType },
    { action: "wallet", derivationFields },
  );
  console.log(JSON.stringify(result, null, 2));
}

async function runDerive(args: string[]) {
  const accountPath = getOption(args, "--account");
  const inputPath = getOption(args, "--input");
  if (!accountPath || !inputPath) {
    fail("Missing --account or --input");
  }

  const account = JSON.parse(readFileSync(resolve(accountPath), "utf-8")) as AccountResponse;
  const derivationFields = JSON.parse(
    readFileSync(resolve(inputPath), "utf-8"),
  ) as DerivationFields;
  const wallet = await deriveDepositWallet(account, derivationFields);
  console.log(JSON.stringify(wallet, null, 2));
}

const [subcommand, ...rest] = process.argv.slice(2);
switch (subcommand) {
  case "account":
    await runAccount(rest);
    break;
  case "wallet":
    await runWallet(rest);
    break;
  case "derive":
    await runDerive(rest);
    break;
  default:
    fail(subcommand ? `Unknown subcommand: ${subcommand}` : "Missing subcommand");
}
