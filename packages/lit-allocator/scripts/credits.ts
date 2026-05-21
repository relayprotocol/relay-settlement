#!/usr/bin/env tsx
/**
 * Read the account-level credit balance from Chipotle's `/billing/balance`
 * endpoint using a usage API key.
 *
 * The endpoint authenticates with `X-Api-Key`, accepts either a usage or an
 * account API key, and returns the same account-level balance for both. We
 * use the usage key minted by `setup` since it's lower-privilege and works
 * uniformly for both API-mode and ChainSecured accounts.
 *
 * Usage:
 *   tsx scripts/credits.ts --usage-api-key <key>
 */

const BILLING_BALANCE_URL = "https://api.chipotle.litprotocol.com/core/v1/billing/balance";

const USAGE = "Usage:\n  tsx scripts/credits.ts --usage-api-key <key>";

/** Read a CLI flag value accepting `--name value` or `--name=value`. */
function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1) {
    return args[idx + 1];
  }
  const prefix = `${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

interface BillingBalanceResponse {
  balance_cents: number;
  balance_display: string;
}

async function main() {
  const args = process.argv.slice(2);
  const usageApiKey = getOption(args, "--usage-api-key");
  if (!usageApiKey) {
    console.error(`Missing --usage-api-key <key>.\n\n${USAGE}`);
    process.exit(1);
  }

  const res = await fetch(BILLING_BALANCE_URL, {
    method: "GET",
    headers: { "X-Api-Key": usageApiKey },
  });
  if (!res.ok) {
    throw new Error(`/billing/balance failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as BillingBalanceResponse;

  console.log("Credits");
  console.log(`  Display:         ${body.balance_display}`);
  console.log(`  Balance (cents): ${body.balance_cents}`);
  console.log(
    `  (Convention: negative = credits remaining, 0 = exhausted, positive = amount owed.)`,
  );
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
