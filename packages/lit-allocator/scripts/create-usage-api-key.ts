#!/usr/bin/env tsx
/** Mint an additional Chipotle usage API key for the allocator Lit Action group. */

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
    groupPrefix: "allocator",
    displayName: "Lit Allocator",
    chainSecuredPkpName: "Allocator PKP",
    chainSecuredPkpDescription: "Lit Allocator PKP",
  });
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
