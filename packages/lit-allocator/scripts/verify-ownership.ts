#!/usr/bin/env tsx
/**
 * Verify that a given wallet is the current admin of a ChainSecured Chipotle
 * account, without spending any gas or making any state change.
 *
 * Strategy: simulate a self-transfer-of-ownership via `eth_call` from the
 * candidate wallet's address. The contract checks (in order):
 *
 *   1. newAdmin != 0
 *   2. account exists                        ← reverts AccountDoesNotExist
 *   3. !account.managed                      ← reverts InvalidRequest("Account is not ChainSecured")
 *   4. msg.sender == account.adminWallet     ← reverts NoAccountAccess
 *   5. newAdmin != account.adminWallet       ← reverts InvalidRequest("must differ from current admin")
 *
 * Calling `transferChainSecuredAccountOwnership(apiKeyHash, msg.sender)` with
 * `from = candidateAddress` therefore reverts at step 5 ("must differ") iff
 * the candidate IS the current admin, and at step 4 (NoAccountAccess) iff it
 * is NOT. Other reverts pinpoint other failure modes (account missing,
 * still-managed, etc.). No transaction is broadcast; no key is required —
 * only the candidate address.
 *
 * Usage:
 *   tsx scripts/verify-ownership.ts \
 *     --account-api-key <existing-account-api-key> \
 *     (--admin-address 0x... | --admin-private-key 0x...)
 */

import { addr } from "micro-eth-signer";
import {
  bytesToBigInt,
  DEFAULT_ACCOUNT_CONFIG_ADDRESS,
  DEFAULT_BASE_RPC_URL,
  fromHex,
  keccak,
  toHex,
  writeContract,
} from "./setup/backend-chain-secured.js";

const USAGE =
  "Usage:\n" +
  "  tsx scripts/verify-ownership.ts " +
  "--account-api-key <key> " +
  "(--admin-address 0x... | --admin-private-key 0x...)";

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1) {
    return args[idx + 1];
  }
  const prefix = `${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

// ─── eth_call simulation ─────────────────────────────────────────────────────

interface JsonRpcResult {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: { code?: number; message: string; data?: string };
}

/**
 * Issue an `eth_call` that we expect to revert. Returns the raw revert data
 * (or undefined when the RPC didn't expose it) plus the original message so
 * the caller can decide how to interpret it. Does NOT throw on revert.
 */
async function simulateRevert(
  rpcUrl: string,
  from: string,
  to: string,
  calldata: Uint8Array,
): Promise<{ ok: boolean; errorData?: string; errorMessage?: string; result?: string }> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ from, to, data: toHex(calldata) }, "latest"],
    }),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as JsonRpcResult;
  if (body.error) {
    return {
      ok: false,
      errorMessage: body.error.message,
      errorData: body.error.data,
    };
  }
  return { ok: true, result: body.result };
}

// ─── Error decoding ──────────────────────────────────────────────────────────

/** 4-byte selector for a Solidity function/error signature. */
function selector(signature: string): string {
  return `0x${toHex(keccak(new TextEncoder().encode(signature)).slice(0, 4)).slice(2)}`;
}

const SEL_ERROR_STRING = "0x08c379a0"; // Error(string) — solidity revert("...")
const SEL_INVALID_REQUEST = selector("InvalidRequest(string)");
const SEL_NO_ACCOUNT_ACCESS = selector("NoAccountAccess(uint256,address)");
const SEL_ACCOUNT_DOES_NOT_EXIST = selector("AccountDoesNotExist(uint256)");
const SEL_ACCOUNT_ALREADY_EXISTS = selector("AccountAlreadyExists(uint256)");

/** Decode a single-string-argument ABI-encoded body (selector already stripped). */
function decodeStringArg(bodyBytes: Uint8Array): string | undefined {
  if (bodyBytes.length < 64) {
    return undefined;
  }
  // [0..32) = offset (always 0x20 for a single string arg)
  // [32..64) = length
  // [64..)  = UTF-8 bytes
  const length = Number(bytesToBigInt(bodyBytes.slice(32, 64)));
  if (length === 0 || bodyBytes.length < 64 + length) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes.slice(64, 64 + length));
  } catch {
    return undefined;
  }
}

interface DecodedRevert {
  /** Best-effort human-readable name of the contract error. */
  name: string;
  /** Best-effort decoded message string if the error has a string arg. */
  message?: string;
  /** Raw revert data, useful for filing bug reports if we can't decode. */
  raw: string;
}

function decodeRevert(
  errorData: string | undefined,
  errorMessage: string | undefined,
): DecodedRevert {
  const raw = errorData ?? errorMessage ?? "";
  if (!errorData || !errorData.startsWith("0x") || errorData.length < 10) {
    return { name: "Unknown", message: errorMessage, raw };
  }
  const sel = errorData.slice(0, 10).toLowerCase();
  const body = fromHex(errorData.slice(10));

  if (sel === SEL_ERROR_STRING.toLowerCase()) {
    return { name: "Error", message: decodeStringArg(body), raw };
  }
  if (sel === SEL_INVALID_REQUEST.toLowerCase()) {
    return { name: "InvalidRequest", message: decodeStringArg(body), raw };
  }
  if (sel === SEL_NO_ACCOUNT_ACCESS.toLowerCase()) {
    return { name: "NoAccountAccess", raw };
  }
  if (sel === SEL_ACCOUNT_DOES_NOT_EXIST.toLowerCase()) {
    return { name: "AccountDoesNotExist", raw };
  }
  if (sel === SEL_ACCOUNT_ALREADY_EXISTS.toLowerCase()) {
    return { name: "AccountAlreadyExists", raw };
  }
  return { name: `Unknown(selector=${sel})`, raw };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const accountApiKey = getOption(args, "--account-api-key");
  const adminAddressArg = getOption(args, "--admin-address");
  const adminPrivateKey = getOption(args, "--admin-private-key");

  const missing: string[] = [];
  if (!accountApiKey) {
    missing.push("--account-api-key <key>");
  }
  if (!adminAddressArg && !adminPrivateKey) {
    missing.push("--admin-address 0x... or --admin-private-key 0x...");
  }
  if (missing.length > 0 || !accountApiKey) {
    console.error(`Missing ${missing.join(", ")}.\n\n${USAGE}`);
    process.exit(1);
  }
  if (adminAddressArg && adminPrivateKey) {
    console.error(`Pass only one of --admin-address or --admin-private-key, not both.\n\n${USAGE}`);
    process.exit(1);
  }

  // Resolve the candidate admin address (no signing happens — eth_call only).
  let candidateAddress: string;
  if (adminAddressArg) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(adminAddressArg)) {
      console.error("--admin-address must be a 0x-prefixed 20-byte hex address");
      process.exit(1);
    }
    candidateAddress = adminAddressArg.toLowerCase();
  } else {
    const normalizedPk = adminPrivateKey!.startsWith("0x")
      ? adminPrivateKey!
      : `0x${adminPrivateKey!}`;
    try {
      candidateAddress = addr.fromPrivateKey(normalizedPk).toLowerCase();
    } catch (e) {
      console.error(
        `--admin-private-key is not a valid private key: ${e instanceof Error ? e.message : e}`,
      );
      process.exit(1);
    }
  }

  const apiKeyHash = bytesToBigInt(keccak(new TextEncoder().encode(accountApiKey)));

  console.log("🔎 Verifying ChainSecured ownership");
  console.log(`   account API key hash: 0x${apiKeyHash.toString(16).padStart(64, "0")}`);
  console.log(`   candidate admin:      ${candidateAddress}`);
  console.log(`   contract:             ${DEFAULT_ACCOUNT_CONFIG_ADDRESS}`);
  console.log();

  // Self-transfer simulation. msg.sender = candidate, newAdmin = candidate.
  const calldata = writeContract.transferChainSecuredAccountOwnership.encodeInput({
    apiKeyHash,
    newAdminWalletAddress: candidateAddress,
  });

  const sim = await simulateRevert(
    DEFAULT_BASE_RPC_URL,
    candidateAddress,
    DEFAULT_ACCOUNT_CONFIG_ADDRESS,
    calldata,
  );

  if (sim.ok) {
    // Should never happen — we always pick a calldata path that reverts.
    console.log("⚠ The simulation unexpectedly SUCCEEDED.");
    console.log(`  result: ${sim.result}`);
    console.log("  This is an inconsistency between the contract and this script's assumptions.");
    process.exit(2);
  }

  const decoded = decodeRevert(sim.errorData, sim.errorMessage);

  // The "must differ from current admin" InvalidRequest only fires after the
  // msg.sender == admin check passes — that's our positive signal.
  const isPositive =
    decoded.name === "InvalidRequest" &&
    typeof decoded.message === "string" &&
    decoded.message.toLowerCase().includes("differ from current admin");

  if (isPositive) {
    console.log(`✓ ${candidateAddress} is the current admin of this account.`);
    console.log(`  Contract confirmed via eth_call (revert: "${decoded.message}")`);
    return;
  }

  // Negative cases — try to be helpful about why.
  console.log(`✗ ${candidateAddress} is NOT the current admin.`);
  switch (decoded.name) {
    case "NoAccountAccess":
      console.log(`  msg.sender is not registered as admin for this apiKeyHash.`);
      break;
    case "AccountDoesNotExist":
      console.log(`  No account found on-chain for apiKeyHash ${apiKeyHash.toString(16)}.`);
      console.log(`  Either --account-api-key is wrong or the account was never created.`);
      break;
    case "InvalidRequest":
      console.log(`  Contract rejected the probe: "${decoded.message ?? "(no message)"}"`);
      if (decoded.message?.toLowerCase().includes("not chainsecured")) {
        console.log(`  Account is still in API mode — run convert-to-chain-secured first.`);
      }
      break;
    case "AccountAlreadyExists":
      console.log(
        `  The candidate's address hash collides with another existing account, which means`,
      );
      console.log(
        `  this wallet has been admin of a different account before. Pick a fresh wallet.`,
      );
      break;
    default:
      console.log(`  raw revert: ${decoded.raw}`);
      console.log(`  error message: ${sim.errorMessage ?? "(none)"}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
