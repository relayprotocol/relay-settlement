#!/usr/bin/env tsx
/**
 * Invoke the Lighter `changePubKey` Lit Action and print the signed legacy
 * EIP-155 transaction for broadcasting to the Lighter gateway.
 *
 * Usage:
 *   tsx scripts/client/change-pub-key.ts \
 *     --env <name> \
 *     --usage-api-key <key> \
 *     --pkp-id <pkp-address> \
 *     --account-index <uint48> \
 *     --api-key-index <uint8> \
 *     --public-key <hex> \
 *     --tx-nonce <nonce> \
 *     --gas-price <wei> \
 *     --gas-limit <gas>
 */

import { loadEnvironment, parseEnvArg } from "../env.js";
import { CHIPOTLE_API_BASE_URL, executeLitAction } from "./index.js";

const usage =
  "Usage:\n" +
  "  tsx scripts/client/change-pub-key.ts --env <name> --usage-api-key <key> --pkp-id <address> --account-index <uint48> --api-key-index <uint8> --public-key <hex> --tx-nonce <nonce> --gas-price <wei> --gas-limit <gas>";

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
const accountIndex = getOption(args, "--account-index");
const apiKeyIndex = getOption(args, "--api-key-index");
const publicKey = getOption(args, "--public-key");
const txNonce = getOption(args, "--tx-nonce");
const gasPrice = getOption(args, "--gas-price");
const gasLimit = getOption(args, "--gas-limit");

const missing: string[] = [];
if (!apiKey) {
  missing.push("--usage-api-key <key>");
}
if (!pkpId) {
  missing.push("--pkp-id <address>");
}
if (!accountIndex) {
  missing.push("--account-index <uint48>");
}
if (!apiKeyIndex) {
  missing.push("--api-key-index <uint8>");
}
if (!publicKey) {
  missing.push("--public-key <hex>");
}
if (!txNonce) {
  missing.push("--tx-nonce <nonce>");
}
if (!gasPrice) {
  missing.push("--gas-price <wei>");
}
if (!gasLimit) {
  missing.push("--gas-limit <gas>");
}
if (
  missing.length > 0 ||
  !apiKey ||
  !pkpId ||
  !accountIndex ||
  !apiKeyIndex ||
  !publicKey ||
  !txNonce ||
  !gasPrice ||
  !gasLimit
) {
  console.error(`Missing ${missing.join(", ")}.\n\n${usage}`);
  process.exit(1);
}

const env = loadEnvironment(envName);
const result = await executeLitAction(
  { apiBaseUrl: CHIPOTLE_API_BASE_URL, apiKey, pkpId, envName: env.name },
  "lighter-vm",
  {
    action: "changePubKey",
    changePubKey: {
      accountIndex,
      apiKeyIndex,
      publicKey,
      txNonce,
      gasPrice,
      gasLimit,
    },
  },
);

console.log(JSON.stringify(result, null, 2));
