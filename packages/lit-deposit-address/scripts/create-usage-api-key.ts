#!/usr/bin/env tsx
/** Mint an additional Chipotle usage API key for the deposit-address Lit Action group. */

import { runCreateUsageApiKeyCli } from "@relay-protocol/lit-helpers/setup";
import { loadEnvironment, parseEnvArg } from "./env.js";

async function main() {
  const { envName, rest: args } = parseEnvArg(process.argv.slice(2));
  if (!envName) {
    throw new Error("Missing --env <name>.");
  }

  const env = loadEnvironment(envName);
  await runCreateUsageApiKeyCli({
    args,
    envName: env.name,
    groupPrefix: "deposit-address",
    displayName: "Lit Deposit Address",
    chainSecuredPkpName: "Deposit Address PKP",
    chainSecuredPkpDescription: "Lit Deposit Address PKP",
  });
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
