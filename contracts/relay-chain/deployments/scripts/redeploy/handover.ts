import { type Address } from "viem"

import {
  accessControlAbi,
  ADMIN_ROLE,
  deployerAccount,
  loadState,
  log,
  ownableAbi,
  publicClient,
  requireChainId,
  usesStandaloneStore,
  type Env,
  type RedeployState,
} from "./common"
import { roleStep, runSteps } from "./configure"

// Contracts whose ADMIN_ROLE moves to the council. The shared idempotency store
// is not among them: the council already administers it. In standalone mode the
// fresh store IS, because the deployer deployed and admins it.
const adminContracts = (state: RedeployState) =>
  usesStandaloneStore(state.env)
    ? ["inbox", "executor", "genericMapping", "inboxIdempotencyStore"]
    : ["inbox", "executor", "genericMapping"]

// Deployer hands every new contract to the council. Grants always come first;
// the deployer renounces a role only once the council holds it on-chain. The
// deployer's last action, right after configure and verify, before any
// council signature; it does not depend on manifest-cutover.
export async function handover(env: Env, dryRun: boolean) {
  const state = loadState(env)
  const ADMIN_CONTRACTS = adminContracts(state)
  const client = publicClient(state.chainId)
  await requireChainId(client, state.chainId)
  const deployer = deployerAccount().address
  const d = state.deployed
  const owner = (address: Address) =>
    client.readContract({
      abi: ownableAbi,
      address,
      functionName: "owner",
    }) as Promise<Address>
  const pendingOwner = (address: Address) =>
    client.readContract({
      abi: ownableAbi,
      address,
      functionName: "pendingOwner",
    }) as Promise<Address>
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

  const grants = ADMIN_CONTRACTS.map((name) =>
    roleStep(
      state,
      `${name} ADMIN_ROLE → council`,
      d[name],
      ADMIN_ROLE,
      state.council
    )
  )
  await runSteps(
    state,
    [
      ...grants,
      // RelayAllocator is one-step Ownable: the council owns it as soon as
      // this lands, and manifest-activate can then re-point Config at it
      {
        id: "allocator.transferOwnership(council)",
        to: d.allocator,
        abi: ownableAbi,
        functionName: "transferOwnership",
        args: [state.council],
        done: async () => same(await owner(d.allocator), state.council),
      },
      {
        id: "inboxMultisig.transferOwnership(council)",
        to: d.inboxMultisig,
        abi: ownableAbi,
        functionName: "transferOwnership",
        args: [state.council],
        done: async () =>
          same(await owner(d.inboxMultisig), state.council) ||
          same(await pendingOwner(d.inboxMultisig), state.council),
      },
    ],
    dryRun
  )

  for (const name of ADMIN_CONTRACTS) {
    const councilHas = await client.readContract({
      abi: accessControlAbi,
      address: d[name],
      functionName: "hasRole",
      args: [ADMIN_ROLE, state.council],
    })
    if (!councilHas && !dryRun) {
      throw new Error(
        `Council lacks ADMIN_ROLE on ${name}; not renouncing the deployer's`
      )
    }
  }
  await runSteps(
    state,
    ADMIN_CONTRACTS.map((name) =>
      roleStep(
        state,
        `${name} ADMIN_ROLE ✗ deployer`,
        d[name],
        ADMIN_ROLE,
        deployer,
        "renounceRole"
      )
    ),
    dryRun
  )
  log(
    "\nNext: --phase verify, then --phase manifest-activate for the council's round 1"
  )
}
