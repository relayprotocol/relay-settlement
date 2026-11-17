import { type Address, type Hex } from "viem"

import {
  accessControlAbi,
  inboxAbi,
  loadState,
  log,
  publicClient,
  requireChainId,
  usesStandaloneStore,
  WRITE_ROLE,
  type Env,
} from "./common"

// Read-only. Checks that the previous oracle and the new inbox share one
// idempotency store and can both write it, and, with --key, that the two
// contracts and the store agree on whether that key was executed. Used for the
// end-to-end replay proof in the README.
export async function checkSharedStore(
  env: Env,
  flags: Map<string, string | true>
) {
  const state = loadState(env)
  if (usesStandaloneStore(env)) {
    log(
      "==> Shared idempotency store\n  n/a: standalone mode — the new inbox has a fresh store the previous oracle does not share, so there is no shared replay protection to check."
    )
    return
  }
  const client = publicClient(state.chainId)
  await requireChainId(client, state.chainId)
  const previous = state.previous.inbox
  const inbox = state.deployed.inbox
  if (!inbox) throw new Error("No new inbox in the state: run --phase deploy")
  const key = flags.get("key")
  if (key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(String(key))) {
    throw new Error("--key must be a 32-byte hex idempotency key")
  }

  let failures = 0
  const check = (ok: boolean, message: string) => {
    if (!ok) failures++
    log(`  ${ok ? "✅" : "❌"} ${message}`)
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const contracts: [string, Address][] = [
    ["previous oracle", previous],
    ["new inbox", inbox],
  ]

  const sharedStore = state.inputs.idempotencyStore
  if (!sharedStore) {
    throw new Error(
      `${state.env} has no shared idempotency store (standalone mode): nothing to check`
    )
  }

  log("==> Shared idempotency store")
  const stores: Address[] = []
  for (const [label, address] of contracts) {
    const store = (await client.readContract({
      abi: inboxAbi,
      address,
      functionName: "IDEMPOTENCY_STORE",
    })) as Address
    stores.push(store)
    check(
      same(store, sharedStore),
      `${label} ${address}.IDEMPOTENCY_STORE() = ${store}`
    )
  }
  check(same(stores[0], stores[1]), "both contracts read and write one store")

  for (const [label, address] of contracts) {
    const has = (await client.readContract({
      abi: accessControlAbi,
      address: sharedStore,
      args: [WRITE_ROLE, address],
      functionName: "hasRole",
    })) as boolean
    check(has, `store WRITE_ROLE → ${label} ${address}`)
  }

  if (typeof key === "string") {
    log(`\n==> isExecuted(${key})`)
    const views: boolean[] = []
    for (const [label, address] of [
      ...contracts,
      ["store", sharedStore] as [string, Address],
    ]) {
      const executed = (await client.readContract({
        abi: inboxAbi,
        address,
        args: [key as Hex],
        functionName: "isExecuted",
      })) as boolean
      views.push(executed)
      log(`  ${label} ${address}: ${executed}`)
    }
    check(
      views.every((view) => view === views[0]),
      `all views agree (${views[0] ? "executed" : "not executed"})`
    )
  }

  if (failures > 0) throw new Error(`${failures} shared-store check(s) failed`)
  log("\nShared store checks passed")
}
