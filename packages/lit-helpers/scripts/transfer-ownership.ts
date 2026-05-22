#!/usr/bin/env tsx
/**
 * Transfer ownership of a ChainSecured account from the current admin wallet
 * to a new wallet, by invoking the AccountConfig diamond's
 * `transferChainSecuredAccountOwnership(uint256 apiKeyHash, address newAdmin)`
 * function (added in chipotle PR #346).
 *
 * No HTTP endpoint exists for this yet — we send the transaction directly to
 * the AccountConfig contract on Base, signed by the current admin wallet
 * (`msg.sender` must equal `account.adminWalletAddress`). The contract:
 *
 *   - reverts on zero / self / managed / missing accounts
 *   - reverts if `newAdminWalletAddress` is already admin of any other account
 *     (i.e. `keccak256(newAdmin)` collides with an existing master hash)
 *   - preserves the master `apiKeyHash` and billing wallet, so groups,
 *     actions, PKPs, usage keys, and billing remain attached
 *   - registers a new entry `allApiKeyHashesToMaster[keccak256(newAdmin)] = master`
 *     so the new admin can sign future writes
 *
 * The new admin can be specified by **either** its address or its private
 * key (the address will be derived in the latter case) — exactly one of
 * `--new-admin-address` or `--new-admin-private-key` is required.
 *
 * Usage:
 *   tsx scripts/transfer-ownership.ts \
 *     --account-api-key <existing-account-api-key> \
 *     --current-admin-private-key 0x<current-admin-key> \
 *     (--new-admin-address 0x... | --new-admin-private-key 0x...)
 */

import { addr } from "micro-eth-signer"
import {
  bytesToBigInt,
  DEFAULT_ACCOUNT_CONFIG_ADDRESS,
  DEFAULT_BASE_CHAIN_ID,
  DEFAULT_BASE_RPC_URL,
  keccak,
  sendTransaction,
  writeContract,
} from "../src/chainSecured.js"

const USAGE =
  "Usage:\n" +
  "  tsx scripts/transfer-ownership.ts " +
  "--account-api-key <key> " +
  "--current-admin-private-key 0x... " +
  "(--new-admin-address 0x... | --new-admin-private-key 0x...)"

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx !== -1) {
    return args[idx + 1]
  }
  const prefix = `${name}=`
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

async function main() {
  const args = process.argv.slice(2)
  const accountApiKey = getOption(args, "--account-api-key")
  const currentAdminPrivateKey = getOption(args, "--current-admin-private-key")
  const newAdminAddressArg = getOption(args, "--new-admin-address")
  const newAdminPrivateKey = getOption(args, "--new-admin-private-key")

  const missing: string[] = []
  if (!accountApiKey) {
    missing.push("--account-api-key <key>")
  }
  if (!currentAdminPrivateKey) {
    missing.push("--current-admin-private-key 0x...")
  }
  if (!newAdminAddressArg && !newAdminPrivateKey) {
    missing.push("--new-admin-address 0x... or --new-admin-private-key 0x...")
  }
  if (missing.length > 0 || !accountApiKey || !currentAdminPrivateKey) {
    console.error(`Missing ${missing.join(", ")}.\n\n${USAGE}`)
    process.exit(1)
  }
  if (newAdminAddressArg && newAdminPrivateKey) {
    console.error(
      `Pass only one of --new-admin-address or --new-admin-private-key, not both.\n\n${USAGE}`
    )
    process.exit(1)
  }

  // Resolve the new admin address: either provided directly, or derived from
  // its private key. The contract only needs the address — the new owner
  // never has to expose their key during the transfer.
  let newAdminAddressLc: string
  if (newAdminAddressArg) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(newAdminAddressArg)) {
      console.error(
        "--new-admin-address must be a 0x-prefixed 20-byte hex address"
      )
      process.exit(1)
    }
    newAdminAddressLc = newAdminAddressArg.toLowerCase()
  } else {
    const normalizedNewAdminPk = newAdminPrivateKey!.startsWith("0x")
      ? newAdminPrivateKey!
      : `0x${newAdminPrivateKey!}`
    try {
      newAdminAddressLc = addr
        .fromPrivateKey(normalizedNewAdminPk)
        .toLowerCase()
    } catch (e) {
      console.error(
        `--new-admin-private-key is not a valid private key: ${e instanceof Error ? e.message : e}`
      )
      process.exit(1)
    }
  }

  const normalizedPk = currentAdminPrivateKey.startsWith("0x")
    ? currentAdminPrivateKey
    : `0x${currentAdminPrivateKey}`
  const currentAdminAddress = addr.fromPrivateKey(normalizedPk).toLowerCase()
  if (currentAdminAddress === newAdminAddressLc) {
    console.error(
      "--new-admin-address must differ from the address derived from --current-admin-private-key"
    )
    process.exit(1)
  }

  // The account is keyed on-chain by keccak256(toUtf8Bytes(accountApiKey)),
  // the same hash setup.ts uses. The contract accepts any hash that resolves
  // to the master entry (incl. keccak256(currentAdminAddress) for accounts
  // that have been transferred once already), but using the original API key
  // hash is the canonical and most stable input.
  const apiKeyHash = bytesToBigInt(
    keccak(new TextEncoder().encode(accountApiKey))
  )

  console.log("🔁 Transferring ChainSecured account ownership")
  console.log(
    `   account API key hash: 0x${apiKeyHash.toString(16).padStart(64, "0")}`
  )
  console.log(`   current admin:        ${currentAdminAddress}`)
  console.log(`   new admin:            ${newAdminAddressLc}`)
  console.log(`   contract:             ${DEFAULT_ACCOUNT_CONFIG_ADDRESS}`)
  console.log(`   chain id:             ${DEFAULT_BASE_CHAIN_ID}`)
  console.log()

  const calldata =
    writeContract.transferChainSecuredAccountOwnership.encodeInput({
      apiKeyHash,
      newAdminWalletAddress: newAdminAddressLc,
    })

  const txHash = await sendTransaction(
    DEFAULT_BASE_RPC_URL,
    DEFAULT_BASE_CHAIN_ID,
    normalizedPk,
    DEFAULT_ACCOUNT_CONFIG_ADDRESS,
    calldata
  )

  console.log()
  console.log(`✓ Ownership transferred.`)
  console.log(`  tx hash: ${txHash}`)
  console.log()
  console.log(
    `  ChainSecured admin writes must now be signed by ${newAdminAddressLc}.`
  )
  console.log(
    `  Continue using --account-api-key="${accountApiKey.slice(0, 6)}…" to identify`
  )
  console.log(
    `  the account; the master apiKeyHash and billing wallet are preserved.`
  )
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
