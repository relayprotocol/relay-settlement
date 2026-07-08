#!/usr/bin/env tsx
/**
 * Overwrite a ChainSecured usage API key's on-chain `balance` (and optionally
 * `expiration`) field.
 *
 * Chipotle ChainSecured deployments meter `/lit_action` calls against the
 * usage key's `balance`; a key minted with `0` is rejected with HTTP 402 even
 * when the account has billing credits. This script re-issues `setUsageApiKey`
 * with the same metadata + group permissions as the existing entry,
 * substituting only the `balance` (and `expiration`, if requested).
 *
 * Usage:
 *   tsx scripts/top-up-usage-key.ts \
 *     --account-api-key <key> \
 *     --admin-private-key 0x... \
 *     (--name <usage-key-name> | --usage-api-key-hash 0x...) \
 *     [--balance <uint256> | --preserve-balance] \
 *     [--expiration <unix-seconds> | --lifetime-seconds <n> | --reset-expiration]
 *
 * Defaults:
 *   --balance      DEFAULT_USAGE_API_KEY_BALANCE (10_000_000)
 *   --expiration   (preserved as-is; pass --reset-expiration to reset to the
 *                   default 10-year lifetime from now)
 *
 * Pass --preserve-balance (with no --expiration flag) for a true no-op write:
 * it re-submits setUsageApiKey with the existing on-chain balance and
 * expiration unchanged. Combined with --calldata this is a handy canary to
 * verify a new owner (e.g. a multisig) can execute admin writes after an
 * ownership transfer, without changing any state.
 */

import {
  CalldataCollector,
  DEFAULT_USAGE_API_KEY_BALANCE,
  DEFAULT_USAGE_API_KEY_LIFETIME_SECONDS,
  defaultUsageApiKeyExpiration,
  printCalldataBatch,
  setUsageApiKeyBalance,
} from "../src/setup/index.js"

const USAGE =
  "Usage:\n" +
  "  tsx scripts/top-up-usage-key.ts " +
  "--account-api-key <key> --admin-private-key 0x... " +
  "(--name <usage-key-name> | --usage-api-key-hash 0x...) " +
  "[--balance <uint256> | --preserve-balance] " +
  "[--expiration <unix-seconds> | --lifetime-seconds <n> | --reset-expiration]\n" +
  "  tsx scripts/top-up-usage-key.ts " +
  "--account-api-key <key> --calldata " +
  "(--name <usage-key-name> | --usage-api-key-hash 0x...) [--balance <uint256>] ...\n" +
  "\n" +
  "  --calldata: emit the setUsageApiKey calldata to relay via the account owner\n" +
  "              (MPC/multisig) instead of broadcasting. No admin key needed."

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx !== -1) {
    return args[idx + 1]
  }
  const prefix = `${name}=`
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(1)
}

function parseBigInt(value: string, field: string): bigint {
  try {
    return BigInt(value)
  } catch {
    fail(`${field} must be a valid uint256 (decimal or 0x-prefixed hex)`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const accountApiKey = getOption(args, "--account-api-key")
  const adminPrivateKey = getOption(args, "--admin-private-key")
  const calldataMode = args.includes("--calldata")
  const name = getOption(args, "--name")
  const usageApiKeyHashArg = getOption(args, "--usage-api-key-hash")
  const balanceArg = getOption(args, "--balance")
  const preserveBalance = args.includes("--preserve-balance")
  const expirationArg = getOption(args, "--expiration")
  const lifetimeArg = getOption(args, "--lifetime-seconds")
  const resetExpiration = args.includes("--reset-expiration")

  if (!accountApiKey) {
    fail("Missing --account-api-key")
  }
  if (!adminPrivateKey && !calldataMode) {
    fail("Missing --admin-private-key (or --calldata)")
  }
  if (!name && !usageApiKeyHashArg) {
    fail("Missing --name or --usage-api-key-hash")
  }
  if (name && usageApiKeyHashArg) {
    fail("Pass only one of --name or --usage-api-key-hash")
  }
  const expirationFlagCount =
    (expirationArg ? 1 : 0) + (lifetimeArg ? 1 : 0) + (resetExpiration ? 1 : 0)
  if (expirationFlagCount > 1) {
    fail(
      "Pass at most one of --expiration, --lifetime-seconds, or --reset-expiration"
    )
  }
  if (preserveBalance && balanceArg) {
    fail("Pass either --balance or --preserve-balance, not both")
  }

  const newBalance = preserveBalance
    ? undefined
    : balanceArg
      ? parseBigInt(balanceArg, "--balance")
      : DEFAULT_USAGE_API_KEY_BALANCE

  let newExpiration: bigint | undefined
  if (expirationArg) {
    newExpiration = parseBigInt(expirationArg, "--expiration")
  } else if (lifetimeArg) {
    newExpiration = defaultUsageApiKeyExpiration(
      parseBigInt(lifetimeArg, "--lifetime-seconds")
    )
  } else if (resetExpiration) {
    newExpiration = defaultUsageApiKeyExpiration(
      DEFAULT_USAGE_API_KEY_LIFETIME_SECONDS
    )
  }

  const target = name
    ? { name }
    : {
        usageApiKeyHash: parseBigInt(
          usageApiKeyHashArg!,
          "--usage-api-key-hash"
        ),
      }

  console.log(
    preserveBalance
      ? "🪩 No-op usage API key write (balance + expiration preserved)"
      : "💰 Topping up usage API key balance"
  )
  console.log(`   target:        ${name ?? `hash=${usageApiKeyHashArg}`}`)
  console.log(
    `   new balance:   ${preserveBalance ? "(preserved on-chain)" : newBalance}`
  )
  console.log(
    `   new expiration: ${
      newExpiration === undefined ? "(preserved)" : newExpiration.toString()
    }`
  )
  console.log(`   mode:          ${calldataMode ? "calldata" : "broadcast"}`)
  console.log()

  const collector = calldataMode ? new CalldataCollector() : undefined
  const txHash = await setUsageApiKeyBalance({
    privateKey: adminPrivateKey,
    accountApiKey,
    target,
    newBalance,
    preserveBalance,
    newExpiration,
    collector,
  })

  if (collector) {
    printCalldataBatch(collector)
    return
  }

  console.log(`✓ Transaction broadcast: ${txHash}`)
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
