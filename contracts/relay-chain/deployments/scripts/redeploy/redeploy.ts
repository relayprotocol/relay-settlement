#!/usr/bin/env ts-node
/**
 * Redeploys the Hub-chain core contracts of one environment, wires them in,
 * hands them to the security council and freezes the previous set.
 *
 *   yarn ts-node deployments/scripts/redeploy/redeploy.ts --env <dev|stag|prod> --phase <phase> [--dry-run]
 *
 * Phases, in order (see deployments/scripts/redeploy/README.md):
 *
 * The deployer prepares everything (no effect on the live contracts):
 *   inventory          read the live env: chain list, builder inputs, multisig signers
 *   deploy             deploy multisig, inbox (on the live idempotency store), allocator,
 *                      executor, pool draw resolver, generic mapping (LEGACY) and every
 *                      builder the chains need
 *   configure          roles on the new contracts, builder registrations (Lighter included;
 *                      TON and Gateway wait for round 2)
 *   update-records     write the new addresses into deployments/contracts/<env>.json
 *   handover           hand ownership and admin to the council: the deployer's last action
 *   verify             registrations carried over, then verify-deployment.ts: what the
 *                      council checks before signing (it fails before handover)
 *
 * Round 1, one council manifest:
 *   manifest-activate  Hub/store/rate limiter/pool grants, Lighter Config migration,
 *                      inbox multisig acceptOwnership, then Config.setAllocator last
 *
 * Then the solver-config rollout, and:
 *   manifest-register  round 2: INCLUDE_TON=1 (TON_VM_GAS_FEE then the TON registration),
 *                      INCLUDE_GATEWAY=1 (Gateway Config then its registration),
 *                      INCLUDE_MAPPING_FREEZE=1 (previous mapping ORACLE_ROLE revoke)
 *   manifest-cutover   round 3, much later: retire the previous contracts (revocations
 *                      only, DEC-2469 step 6), once DEC-2471 ships and nothing is in flight
 *
 * Security invariants: the new contracts get no Hub role until the council
 * signs round 1; the deployer's last action is handover; the Config admin
 * (the owner of Config.allocator()) moves from the council (previous
 * allocator owner) to the council (new allocator owner) in that one batch, so
 * the deployer never holds it. An env re-pointed under the earlier ordering
 * has the deployer as its Config admin until handover; manifest-activate
 * handles it after handover.
 *
 * The Gateway Config and registration go in the same manifest: its
 * destination builder Config key is shared with the live Gateway builder, so
 * the Config must not land ahead of the registration.
 *
 * Read-only helper, any time after deploy:
 *   check-shared-store  previous oracle and new inbox share the idempotency store and
 *                       can both write it; --key <idempotency key> also compares isExecuted
 *
 * Every phase reads chain state first and skips what is already done, and
 * records progress in deployments/redeploy/<env>.json.
 *
 * Env: DEPLOYER_PRIVATE_KEY, RELAY_RPC_URL (defaults to the public hub RPC),
 * CHAINS_CONFIG / ORACLE_CONFIG_PATH (else fetched with gh), NONCE_OFFSET for
 * manifests, REENABLE_CURRENCIES / MIGRATION_REVIEWED / CONFIRM_DISABLE_ALL for
 * the Lighter Config, INCLUDE_TON=1 with TON_GAS_FEE, INCLUDE_GATEWAY=1 with
 * GATEWAY_ALLOCATORS / MAX_BLOCK_HEIGHT and INCLUDE_MAPPING_FREEZE=1 for
 * manifest-register.
 */

import { checkSharedStore } from "./check-shared-store"
import { parseArgs } from "./common"
import { configure } from "./configure"
import { deploy } from "./deploy"
import { handover } from "./handover"
import { inventory } from "./inventory"
import {
  manifestActivate,
  manifestCutover,
  manifestRegister,
} from "./manifests"
import { updateRecords, verify } from "./records"

async function main() {
  const { env, phase, dryRun, flags } = parseArgs(process.argv.slice(2))
  console.log(`redeploy ${env}: ${phase}${dryRun ? " (dry run)" : ""}\n`)
  switch (phase) {
    case "inventory":
      return inventory(env, flags)
    case "deploy":
      return deploy(env, dryRun)
    case "configure":
      return configure(env, dryRun)
    case "update-records":
      return updateRecords(env, dryRun)
    case "verify":
      return verify(env)
    case "handover":
      return handover(env, dryRun)
    case "manifest-activate":
      return manifestActivate(env, dryRun)
    case "manifest-register":
      return manifestRegister(env, dryRun)
    case "manifest-cutover":
      return manifestCutover(env, dryRun)
    case "check-shared-store":
      return checkSharedStore(env, flags)
    default:
      throw new Error(`Unknown phase ${phase}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
