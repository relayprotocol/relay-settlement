#!/usr/bin/env tsx
/**
 * Remove a ChainSecured usage API key from the account via the
 * `removeUsageApiKey` facet. After removal the same name can be re-minted
 * with a fresh secret (e.g. by re-running the action package's `setup`
 * script).
 *
 * Usage:
 *   tsx scripts/remove-usage-key.ts \
 *     --account-api-key <key> \
 *     --admin-private-key 0x... \
 *     (--name <usage-key-name> | --usage-api-key-hash 0x...)
 */

import { removeUsageApiKey } from "../src/setup/index.js"

const USAGE =
  "Usage:\n" +
  "  tsx scripts/remove-usage-key.ts " +
  "--account-api-key <key> --admin-private-key 0x... " +
  "(--name <usage-key-name> | --usage-api-key-hash 0x...)"

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
  const name = getOption(args, "--name")
  const usageApiKeyHashArg = getOption(args, "--usage-api-key-hash")

  if (!accountApiKey || !adminPrivateKey) {
    fail("Missing --account-api-key or --admin-private-key")
  }
  if (!name && !usageApiKeyHashArg) {
    fail("Missing --name or --usage-api-key-hash")
  }
  if (name && usageApiKeyHashArg) {
    fail("Pass only one of --name or --usage-api-key-hash")
  }

  const target = name
    ? { name }
    : {
        usageApiKeyHash: parseBigInt(
          usageApiKeyHashArg!,
          "--usage-api-key-hash"
        ),
      }

  console.log("🗑  Removing usage API key")
  console.log(`   target: ${name ?? `hash=${usageApiKeyHashArg}`}`)
  console.log()

  const txHash = await removeUsageApiKey({
    privateKey: adminPrivateKey,
    accountApiKey,
    target,
  })

  console.log(`✓ Transaction broadcast: ${txHash}`)
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
