#!/usr/bin/env tsx
/**
 * Convert a managed (API-mode) Chipotle account into a wallet-controlled
 * (ChainSecured) account.
 *
 * Calls `POST /core/v1/convert_to_chain_secured_account` with:
 *
 *   - `X-Api-Key: <accountApiKey>`     — the existing account's admin key,
 *                                        authorizing the conversion
 *   - `new_admin_wallet_address`       — the wallet that will own the
 *                                        ChainSecured account afterwards
 *   - `typed_data` + `signature`       — an EIP-712 `ConvertAccount` envelope
 *                                        signed by `new_admin_wallet_address`
 *                                        (proves the caller controls that key)
 *
 * Before posting we run a read-only sanity check that the new admin wallet's
 * address-hash slot in the contract is still free. The contract sticks
 * `allApiKeyHashesToMaster[keccak256(newAdmin)] = master` during conversion,
 * and the slot is permanent — if the wallet has ever been admin of any
 * other account it can't be reused. We surface that as a clear error instead
 * of letting the opaque server-side `Contract error: <uint256>` bubble up.
 *
 * Since the storage mapping isn't exposed by any public getter, we probe it
 * indirectly via `eth_call transferChainSecuredAccountOwnership(slot, dummy)`
 * — the contract reverts `AccountDoesNotExist(slot)` iff the slot is empty.
 *
 * After the call, the original `--account-api-key` continues to identify the
 * account on-chain via `keccak256(toUtf8Bytes(accountApiKey))` (the same hash
 * `setup` already uses), so existing usage keys, groups, actions, and PKPs
 * stay attached. The new admin wallet is the only entity that can sign
 * ChainSecured admin writes from here on.
 *
 * Usage:
 *   tsx scripts/convert-to-chain-secured.ts \
 *     --account-api-key <existing-account-api-key> \
 *     --new-admin-private-key 0x<new-admin-wallet-key>
 */

import { addr } from "micro-eth-signer";
import {
  bytesToBigInt,
  DEFAULT_ACCOUNT_CONFIG_ADDRESS,
  DEFAULT_BASE_CHAIN_ID,
  DEFAULT_BASE_RPC_URL,
  fromHex,
  keccak,
  signChainSecuredTypedData,
  toHex,
  writeContract,
} from "./setup/backend-chain-secured.js";

const CONVERT_URL = "https://api.chipotle.litprotocol.com/core/v1/convert_to_chain_secured_account";

const USAGE =
  "Usage:\n" +
  "  tsx scripts/convert-to-chain-secured.ts " +
  "--account-api-key <key> --new-admin-private-key 0x...";

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1) {
    return args[idx + 1];
  }
  const prefix = `${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** Format a uint256 as a 0x-prefixed, zero-padded 64-hex-char string. */
function formatHash(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** 4-byte selector for a Solidity function/error signature. */
function selector(signature: string): string {
  return `0x${toHex(keccak(new TextEncoder().encode(signature)).slice(0, 4)).slice(2)}`;
}

const SEL_ACCOUNT_DOES_NOT_EXIST = selector("AccountDoesNotExist(uint256)");

/**
 * Probe whether `AppStorage.allApiKeyHashesToMaster[lookupHash]` is empty by
 * simulating `transferChainSecuredAccountOwnership(lookupHash, 0xff..ff)` via
 * `eth_call`. The contract reads the slot first and reverts
 * `AccountDoesNotExist(slot)` when it's zero, so a matching selector means
 * the slot is FREE. Any other revert means the slot is TAKEN.
 */
async function isLookupHashFree(rpcUrl: string, lookupHash: bigint): Promise<boolean> {
  // newAdminWalletAddress must be non-zero per the contract's first guard;
  // 0xff..ff is guaranteed to never be a real EOA and never appear in
  // anyone's allApiKeyHashesToMaster.
  const dummyNewAdmin = `0x${"ff".repeat(20)}`;
  const calldata = writeContract.transferChainSecuredAccountOwnership.encodeInput({
    apiKeyHash: lookupHash,
    newAdminWalletAddress: dummyNewAdmin,
  });
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { from: dummyNewAdmin, to: DEFAULT_ACCOUNT_CONFIG_ADDRESS, data: toHex(calldata) },
        "latest",
      ],
    }),
  });
  const body = (await res.json()) as {
    result?: string;
    error?: { data?: string; message: string };
  };
  if (!body.error) {
    throw new Error(`isLookupHashFree: probe unexpectedly succeeded with result ${body.result}`);
  }
  const data = body.error.data?.toLowerCase() ?? "";
  return data.startsWith(SEL_ACCOUNT_DOES_NOT_EXIST.toLowerCase());
}

/**
 * Best-effort interpretation of the server's `Contract error: <uint256>`
 * format. The integer is the first arg of whichever Solidity custom error
 * the contract reverted with; we cross-reference it against the two hashes
 * we already know to label it as either an `AccountAlreadyExists` or an
 * `AccountDoesNotExist`-style failure.
 */
function explainContractError(
  rawErrorText: string,
  apiKeyHash: bigint,
  newAdminAddressHash: bigint,
): string | undefined {
  // Server pattern observed: "...Contract error: <decimal-uint256>"
  const match = rawErrorText.match(/Contract error:\s*(\d+)/);
  if (!match) {
    return undefined;
  }
  const value = BigInt(match[1]);
  const valueHex = formatHash(value);
  const lines = [`Contract reverted with uint256 = ${valueHex}.`];
  if (value === newAdminAddressHash) {
    lines.push(
      `That value equals keccak256(abi.encodePacked(newAdminAddress)) — the new`,
      `admin wallet has already been registered as admin of some account on-chain.`,
      `(allApiKeyHashesToMaster is sticky; once a wallet is admin anywhere, its`,
      `hash slot stays occupied even after a transfer.) Pick a different wallet.`,
    );
  } else if (value === apiKeyHash) {
    lines.push(
      `That value equals keccak256(toUtf8Bytes(accountApiKey)) — the original`,
      `account hash. Check whether the account exists / has already been`,
      `converted with this key.`,
    );
  } else {
    lines.push(
      `That value matches neither of the two hashes derived from the inputs`,
      `(apiKeyHash=${valueHex === formatHash(apiKeyHash) ? "yes" : "no"},`,
      `newAdminAddressHash=${valueHex === formatHash(newAdminAddressHash) ? "yes" : "no"}).`,
      `It's probably an unrelated apiKeyHash collision — investigate which`,
      `account on-chain owns this slot.`,
    );
  }
  return lines.join("\n  ");
}

async function main() {
  const args = process.argv.slice(2);
  const accountApiKey = getOption(args, "--account-api-key");
  const newAdminPrivateKey = getOption(args, "--new-admin-private-key");
  const missing: string[] = [];
  if (!accountApiKey) {
    missing.push("--account-api-key <key>");
  }
  if (!newAdminPrivateKey) {
    missing.push("--new-admin-private-key 0x...");
  }
  if (missing.length > 0 || !accountApiKey || !newAdminPrivateKey) {
    console.error(`Missing ${missing.join(", ")}.\n\n${USAGE}`);
    process.exit(1);
  }

  const normalizedPk = newAdminPrivateKey.startsWith("0x")
    ? newAdminPrivateKey
    : `0x${newAdminPrivateKey}`;
  const newAdminAddress = addr.fromPrivateKey(normalizedPk).toLowerCase();
  const apiKeyHash = bytesToBigInt(keccak(new TextEncoder().encode(accountApiKey)));
  // keccak256(abi.encodePacked(address)) — encodePacked of a single address
  // is just the 20 raw bytes, no padding.
  const newAdminAddressHash = bytesToBigInt(keccak(fromHex(newAdminAddress)));

  console.log("🔁 Converting account to ChainSecured");
  console.log(`   account API key hash:    ${formatHash(apiKeyHash)}`);
  console.log(`   new admin wallet:        ${newAdminAddress}`);
  console.log(`   new admin address hash:  ${formatHash(newAdminAddressHash)}`);
  console.log();

  // ── Pre-flight: new admin slot must be free ─────────────────────────────
  // The AppStorage.allApiKeyHashesToMaster mapping has no public getter, so
  // we probe it indirectly via the contract's revert behaviour (see
  // isLookupHashFree). This catches the most common convert failure
  // (wallet has been admin somewhere before) before the server has to.
  const free = await isLookupHashFree(DEFAULT_BASE_RPC_URL, newAdminAddressHash);
  if (!free) {
    console.error("✗ Pre-flight: new admin wallet is already in use.");
    console.error(`  allApiKeyHashesToMaster[${formatHash(newAdminAddressHash)}] is already set,`);
    console.error(`  which means this wallet has been admin of some account before.`);
    console.error(`  The contract never frees these slots, so a fresh wallet is required.`);
    console.error(`  Generate a new private key and try again.`);
    process.exit(1);
  }
  console.log(`✓ Pre-flight: new admin slot is free.`);
  console.log();

  // ── Sign + POST ─────────────────────────────────────────────────────────
  const { typed_data, signature } = signChainSecuredTypedData(
    "ConvertAccount",
    newAdminAddress,
    Number(DEFAULT_BASE_CHAIN_ID),
    normalizedPk,
  );

  const res = await fetch(CONVERT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": accountApiKey },
    body: JSON.stringify({
      new_admin_wallet_address: newAdminAddress,
      typed_data,
      signature,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const explained = explainContractError(text, apiKeyHash, newAdminAddressHash);
    let msg = `/convert_to_chain_secured_account failed (${res.status}): ${text}`;
    if (explained) {
      msg += `\n\n  ${explained}`;
    }
    throw new Error(msg);
  }

  console.log("✓ Conversion succeeded.");
  if (text) {
    console.log("  response:", text);
  }
  console.log();
  console.log(
    `  The account is now ChainSecured. Continue using --account-api-key="${accountApiKey.slice(0, 6)}…"`,
  );
  console.log(`  to identify it on-chain (hash derived from the same key).`);
  console.log(`  Admin writes (group/action/PKP/usage-key mutations) now require signing with the`);
  console.log(`  new admin wallet ${newAdminAddress}.`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
