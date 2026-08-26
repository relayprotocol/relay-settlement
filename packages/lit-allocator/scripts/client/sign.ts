#!/usr/bin/env tsx
/**
 * Invoke the `sign` Lit Action and print one signature per hash attested by
 * the oracle. The withdraw request and the oracle attestation are read from
 * a JSON file whose contents match the action's `sign` parameters.
 *
 * Usage:
 *   tsx scripts/client/sign.ts \
 *     --env <name> \
 *     --usage-api-key <key> \
 *     --pkp-id <pkp-address> \
 *     --vm-type <gateway-vm | ethereum-vm | tron-vm | solana-vm | ton-vm | bitcoin-vm | hyperliquid-vm | lighter-vm | xrp-vm | hedera-vm> \
 *     --input <path-to-request.json>
 *
 * Example request.json:
 *   {
 *     "destinationVmType": "ethereum-vm",
 *     "withdrawRequest": {
 *       "chainId": "...",
 *       "depository": "0x...",
 *       "currency": "0x...",
 *       "amount": "...",
 *       "spenderChainId": "...",
 *       "spender": "0x...",
 *       "receiver": "0x...",
 *       "data": "0x",
 *       "nonce": "0x..."
 *     },
 *     "attestation": {
 *       "chainId": 421614,
 *       "allocator": "0x...",
 *       "withdrawRequestHash": "0x...",
 *       "hashesToSign": ["0x..."],
 *       "signatures": [
 *         { "oracleSigner": "0x...", "signature": "0x..." }
 *       ]
 *     }
 *   }
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VM_TYPES, loadEnvironment, parseEnvArg, type VmType } from "../env.js";
import { CHIPOTLE_API_BASE_URL, executeLitAction } from "./index.js";

const usage =
  "Usage:\n" +
  "  tsx scripts/client/sign.ts --env <name> --usage-api-key <key> --pkp-id <address> --vm-type <gateway-vm|ethereum-vm|tron-vm|solana-vm|ton-vm|bitcoin-vm|hyperliquid-vm|lighter-vm|xrp-vm|hedera-vm> --input <path>";

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
const inputPath = getOption(args, "--input");
const missing: string[] = [];
if (!apiKey) {
  missing.push("--usage-api-key <key>");
}
if (!pkpId) {
  missing.push("--pkp-id <address>");
}
if (!vmTypeArg) {
  missing.push(
    "--vm-type <gateway-vm|ethereum-vm|tron-vm|solana-vm|ton-vm|bitcoin-vm|hyperliquid-vm|lighter-vm|xrp-vm|hedera-vm>",
  );
}
if (!inputPath) {
  missing.push("--input <path>");
}
if (missing.length > 0 || !apiKey || !pkpId || !vmTypeArg || !inputPath) {
  console.error(`Missing ${missing.join(", ")}.\n\n${usage}`);
  process.exit(1);
}

if (!(VM_TYPES as readonly string[]).includes(vmTypeArg)) {
  console.error(`unsupported --vm-type: ${vmTypeArg}. Supported: ${VM_TYPES.join(", ")}`);
  process.exit(1);
}
const vmType = vmTypeArg as VmType;

const request = JSON.parse(readFileSync(resolve(inputPath), "utf-8")) as {
  destinationVmType?: string;
  withdrawRequest: Record<string, unknown>;
  attestation: Record<string, unknown>;
};
if (!request.withdrawRequest || !request.attestation) {
  console.error(`${inputPath} must contain both "withdrawRequest" and "attestation" objects`);
  process.exit(1);
}
if (
  vmType === "gateway-vm" &&
  request.destinationVmType !== "ethereum-vm" &&
  request.destinationVmType !== "solana-vm"
) {
  console.error(`${inputPath} must contain destinationVmType "ethereum-vm" or "solana-vm"`);
  process.exit(1);
}

const env = loadEnvironment(envName);
const result = await executeLitAction(
  { apiBaseUrl: CHIPOTLE_API_BASE_URL, apiKey, pkpId, envName: env.name },
  vmType,
  {
    action: "sign",
    ...(vmType === "gateway-vm" ? { destinationVmType: request.destinationVmType } : {}),
    withdrawRequest: request.withdrawRequest,
    attestation: request.attestation,
  },
);

console.log(JSON.stringify(result, null, 2));
