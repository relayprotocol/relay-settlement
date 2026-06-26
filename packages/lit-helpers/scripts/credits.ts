#!/usr/bin/env tsx
/**
 * Read the account-level credit balance from Chipotle's `/billing/balance`
 * endpoint using an account API key.
 *
 * Usage:
 *   tsx scripts/credits.ts --account-api-key <key>
 */

const BILLING_BALANCE_URL =
  "https://api.chipotle.litprotocol.com/core/v1/billing/balance"

const USAGE = "Usage:\n  tsx scripts/credits.ts --account-api-key <key>"

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx !== -1) {
    return args[idx + 1]
  }
  const prefix = `${name}=`
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

interface BillingBalanceResponse {
  balance_cents: number
  balance_display: string
}

async function main() {
  const args = process.argv.slice(2)
  const accountApiKey = getOption(args, "--account-api-key")
  if (!accountApiKey) {
    console.error(`Missing --account-api-key <key>.\n\n${USAGE}`)
    process.exit(1)
  }

  const res = await fetch(BILLING_BALANCE_URL, {
    method: "GET",
    headers: { "X-Api-Key": accountApiKey },
  })
  if (!res.ok) {
    throw new Error(
      `/billing/balance failed (${res.status}): ${await res.text()}`
    )
  }
  const body = (await res.json()) as BillingBalanceResponse

  console.log("Credits")
  console.log(`  Display:         ${body.balance_display}`)
  console.log(`  Balance (cents): ${body.balance_cents}`)
  console.log(
    `  (Convention: negative = credits remaining, 0 = exhausted, positive = amount owed.)`
  )
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
