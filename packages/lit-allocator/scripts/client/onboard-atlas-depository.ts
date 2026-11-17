#!/usr/bin/env tsx
/**
 * Invoke the Atlas `onboard` Lit Action and print the signed wallet-opening
 * bind as the raw envelope `atlas.sendWalletReadyRequest` takes, with the
 * statements to send beside it.
 *
 * Usage:
 *   tsx scripts/client/onboard-atlas-depository.ts \
 *     --env <name> \
 *     --usage-api-key <key> \
 *     --pkp-id <pkp-address> \
 *     --terms "<id>@<version> 0x<contentHash>" \
 *     --expires-at <unix-seconds>
 *
 * `--terms` is the version in force from `atlas.getTerms`; `--expires-at` is
 * at most a day ahead.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { loadEnvironment, parseEnvArg } from "../env.js";
import { CHIPOTLE_API_BASE_URL, executeLitAction } from "./index.js";

interface AtlasStatement {
  label: string;
  value: string;
}

const encoder = new TextEncoder();
const STATEMENT_TYPE_HASH = keccak_256(encoder.encode("Statement(string label,string value)"));

const word = (value: bigint | number, bytes: number) => {
  const n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(bytes * 8)) {
    throw new Error(`${n} does not fit in ${bytes} bytes`);
  }
  return n.toString(16).padStart(bytes * 2, "0");
};

/** The 32 bytes a bind carries for its statements: keccak256 of the lines' struct hashes. */
function hashAtlasStatements(statements: AtlasStatement[]): string {
  const lines = statements.map(({ label, value }) =>
    keccak_256(
      Buffer.concat([
        STATEMENT_TYPE_HASH,
        keccak_256(encoder.encode(label)),
        keccak_256(encoder.encode(value)),
      ]),
    ),
  );
  return Buffer.from(keccak_256(Buffer.concat(lines))).toString("hex");
}

/**
 * Envelope of the account's reduce-only self-bind at gapless nonce 1, with no
 * Builder Fee: the only bind the `onboard` action signs.
 */
function encodeAtlasBindEnvelope(params: {
  account: string;
  expiresAt: bigint;
  statements: AtlasStatement[];
  /** `r ‖ s ‖ v` as the action returns it, v = 0 or 1. */
  signature: string;
  chainId: number;
}): string {
  const account = params.account.replace(/^0x/, "").toLowerCase();
  const signature = params.signature.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(account) || !/^[0-9a-f]{130}$/.test(signature)) {
    throw new Error("account must be 20 bytes and signature 65 bytes");
  }
  return (
    "0x00" +
    account +
    "00" +
    word(1, 8) +
    word(params.expiresAt, 8) +
    "ef2b" +
    account +
    account +
    "00" +
    word(2, 1) +
    word(0, 8) +
    word(0, 8) +
    word(0, 1) +
    hashAtlasStatements(params.statements) +
    "11" +
    word(params.chainId, 4) +
    signature
  );
}

const usage =
  "Usage:\n" +
  '  tsx scripts/client/onboard-atlas-depository.ts --env <name> --usage-api-key <key> --pkp-id <address> --terms "<id>@<version> 0x<contentHash>" --expires-at <unix-seconds>';

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
const terms = getOption(args, "--terms");
const expiresAt = getOption(args, "--expires-at");

const missing: string[] = [];
if (!apiKey) {
  missing.push("--usage-api-key <key>");
}
if (!pkpId) {
  missing.push("--pkp-id <address>");
}
if (!terms) {
  missing.push('--terms "<id>@<version> 0x<contentHash>"');
}
if (!expiresAt) {
  missing.push("--expires-at <unix-seconds>");
}
if (missing.length > 0 || !apiKey || !pkpId || !terms || !expiresAt) {
  console.error(`Missing ${missing.join(", ")}.\n\n${usage}`);
  process.exit(1);
}

const env = loadEnvironment(envName);
if (!env.atlasDomain) {
  console.error(`Environment ${env.name} has no Atlas domain.`);
  process.exit(1);
}

const statements = [
  { label: "Atlas Terms of Use", value: terms },
  { label: "Request", value: "enableTrading" },
];
const result = (await executeLitAction(
  { apiBaseUrl: CHIPOTLE_API_BASE_URL, apiKey, pkpId, envName: env.name },
  "atlas-vm",
  { action: "onboard", bind: { expiresAt, statements } },
)) as { address: string; results: Array<{ hash: string; signature: string }> };

const rawTx = encodeAtlasBindEnvelope({
  account: result.address,
  expiresAt: BigInt(expiresAt),
  statements,
  signature: result.results[0].signature,
  chainId: env.atlasDomain.chainId,
});

console.log(
  JSON.stringify(
    {
      address: result.address,
      digest: result.results[0].hash,
      method: "atlas.sendWalletReadyRequest",
      params: ["enableTrading", rawTx, statements],
    },
    null,
    2,
  ),
);
