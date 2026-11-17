# Hub-chain core redeploy

Redeploys the Hub-chain core contracts of one environment (the inbox
multisig, inbox, allocator, executor, pool draw resolver, generic mapping and
the payload builders its chains need) next to the live set, and hands them to
the security council. The Hub, Config, depositories, price oracle, rate
limiter, fee calculator and idempotency store are kept. The same commands run
for every env.

```sh
cd contracts/relay-chain
yarn redeploy --env <env> --phase <phase> [--dry-run]
```

Every phase reads chain state first and skips work already done, so it can be
re-run. Progress is recorded in `deployments/redeploy/<env>.json`.

## Security invariants

- The new contracts get no Hub role until the council signs round 1.
- The deployer's last action is `handover`; `verify` runs only after it, and
  is what the council checks before signing.
- The Config admin (`Config.allocator().owner()`) moves from the council (the
  previous allocator's owner) to the council (the new allocator's owner) in
  one batch, `manifest-activate`, with `Config.setAllocator` last. The
  deployer never holds it.

## Phases

| #   | Phase                 | Who       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     | **Deployer prepares** |           | No effect on the live contracts                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1   | `inventory`           | read-only | Chain list (every depository per chain), live registrations (`PayloadBuilderSet` events from `--from-block`, in `--log-page-size` chunks, must all be in the chains config), builder inputs, multisig signers, the live idempotency store. Fails if a skipped depository is registered on the previous allocator. `--force` is refused once `<env>.json` holds the new contracts                                                                      |
| 2   | `deploy`              | deployer  | Every contract above, in dependency order                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | `configure`           | deployer  | `ORACLE_ROLE` grants, rate limiter and fee calculator allowlists, builder registrations for every depository in the chains config (every previous registration must be among them), Lighter included (nothing routes to the new allocator before the solver overrides). TON and Gateway wait for round 2                                                                                                                                              |
| 4   | `update-records`      | —         | Writes the new addresses into `deployments/contracts/<env>.json`                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | `handover`            | deployer  | Council gets `ADMIN_ROLE`, allocator ownership and pending multisig ownership; the deployer renounces once the council holds each role                                                                                                                                                                                                                                                                                                                |
| 6   | `verify`              | read-only | After `handover`, what the council checks before signing round 1: every configured depository carries the new builder and every previous registration is among them, then `verify-deployment.ts`; fails if either fails. Stage allowances come from chain state: the exact grants `manifest-cutover` revokes until it does, the new contracts' grants until `manifest-activate`, TON and Gateway until `manifest-register`                            |
|     | **Round 1**           |           |                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7   | `manifest-activate`   | council   | One manifest: Hub, store, rate limiter and pool grants (and abandoned-inbox revokes), the Lighter Config migration, `RelayInboxMultisig.acceptOwnership()`, `Config.setAllocator` last. Refused before `handover`                                                                                                                                                                                                                                     |
| —   | solver-config rollout | humans    | Oracle, signer, Lit, relayer, indexer and solver configs move to the new contracts                                                                                                                                                                                                                                                                                                                                                                    |
|     | **Round 2**           |           | After DEC-2471                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | `manifest-register`   | council   | Refused until `manifest-activate` executed. `INCLUDE_TON=1`: `TON_VM_GAS_FEE` then the TON registration (the Highload wallet must not serve two issuing allocators). `INCLUDE_GATEWAY=1`: the Gateway registration then its Config, in one manifest, since the Gateway keys are shared with the live builder (if the registration reverts, do not execute the Config writes). `INCLUDE_MAPPING_FREEZE=1`: the previous mapping's `ORACLE_ROLE` revoke |
|     | **Round 3**           |           | Retirement (DEC-2469 step 6), once the previous contracts have nothing in flight                                                                                                                                                                                                                                                                                                                                                                      |
| 9   | `manifest-cutover`    | council   | Requires `CONFIRM_RETIREMENT=1`, `manifest-activate` executed and the TON and Gateway registrations. Revocations only: the previous allocator, executor, oracle and WithdrawGasPayer from the Hub, the previous mapping's oracle (skipped once frozen), the rate limiter consumer and the pool resolvers                                                                                                                                              |

Council manifests are written to `packages/multisig-tools/transactions/<env>/`
with gas simulated from the council (no call depends on an earlier one in its
manifest), then go through `multisig:simulate`, `multisig:submit`, Safe
approval and `multisig:execute`. A manifest's `rpc` is always the public hub
RPC.

An env whose Config was re-pointed before handover by an earlier version of
this tool (dev) runs `handover`, then `manifest-activate`, which then holds
only `acceptOwnership`.

## Shared idempotency store

### Why it is shared

The new inbox and the previous oracle both run while services move over, and
an execution can be signed for both. `RelayInboxIdempotencyStore.isExecuted`
also checks the store's sources, but the previous oracle checks only its own
store. With a separate new store that lists the old one as a source, an
execution run on the new inbox first and on the previous oracle second would
run twice. When both contracts write the same store (the store's documented
way for oracle versions to share replay protection: each gets `WRITE_ROLE`),
whichever runs first marks the key and the other rejects it, in either order.

So `inventory` takes the store from `oracleIdempotencyStore` in `<env>.json`
and fails unless the live oracle's `IDEMPOTENCY_STORE()` is that address,
`deploy` passes it to the new inbox, and `manifest-activate` has the council (the
store's admin) grant the new inbox `WRITE_ROLE`. The previous oracle keeps its
`WRITE_ROLE`; `manifest-cutover` retires it by revoking its Hub `OPERATOR_ROLE`.

### Checking it

`--phase check-shared-store` is read-only and can run any time after `deploy`.
It checks that the previous oracle and the new inbox return the same
`IDEMPOTENCY_STORE()`, the one recorded by `inventory`, and that both hold its
`WRITE_ROLE` (the new inbox only once `manifest-activate` has executed). With
`--key <idempotency key>` it also checks that `isExecuted` returns the same
value on the previous oracle, the new inbox and the store.

`verify` passes the previous oracle to `verify-deployment.ts` as
`PREVIOUS_ORACLES`. Its `WRITE_ROLE` on the store is then reported as expected
(ℹ️) instead of as an undeclared holder, but only if its own
`IDEMPOTENCY_STORE()` is that store.

### End-to-end replay proof (dev)

Before cutover, prove on dev that one execution cannot run on both contracts,
in either order:

1. Pick a dev deposit and have the oracle service sign its execution twice,
   once per target, by setting the request's `executionTarget` (oracle #995):
   once for the new inbox and once for the previous oracle. Both signatures
   carry the same idempotency key.
2. Inbox first: submit the inbox execution. It succeeds. Run
   `check-shared-store --key <key>`: every view reports executed. Submit the
   previous-oracle execution: it must revert with `AlreadyExecuted(<key>)`.
3. Reverse order, with a second deposit: submit the previous-oracle execution
   first, run `check-shared-store --key <key>`, then submit the inbox
   execution: it must revert with `AlreadyExecuted(<key>)`.

A second execution that succeeds in either order means the two contracts do
not share replay protection: stop and do not cut over.

## Environment

- `DEPLOYER_PRIVATE_KEY`: the deployer key.
- `RELAY_RPC_URL`: hub RPC; defaults to the public one for the env's chain id. The chain id is checked against `<env>.json` before any phase runs.
- `CHAINS_CONFIG` / `ORACLE_CONFIG_PATH`: local copies of the oracle repo configs; otherwise they're fetched with `gh`.
- `INCLUDE_TON=1` / `INCLUDE_GATEWAY=1` / `INCLUDE_MAPPING_FREEZE=1`: what `manifest-register` includes, all off by default.
- `NONCE_OFFSET`: added to the council nonce while earlier manifests are pending.
- `--funding-pools a,b` (inventory): pools that are not in `<env>.json`.
- `--from-block` (required: the previous allocator's deployment block, from its creation transaction) and `--log-page-size` (default 10000) (inventory): the `PayloadBuilderSet` event scan. Each request has a timeout and a bounded retry, and a range the RPC rejects as too wide is halved.
- `CONFIRM_RETIREMENT=1` (`manifest-cutover`, required): confirms DEC-2469 step 6 holds, which the tool cannot see. `manifest-cutover` also requires `manifest-activate` executed and every TON and Gateway registration reproduced, unless `ALLOW_PARTIAL_RETIREMENT=1` (logged).
- `TON_GAS_FEE` (nanotons): `TON_VM_GAS_FEE`, needed only while it is unset or to change it.
- `GATEWAY_ALLOCATORS` (required) and `MAX_BLOCK_HEIGHT` (optional; unset leaves the on-chain ceiling): the Gateway values the redeploy sets on purpose, with the new destination builder. Every other Gateway key is shared with the live Gateway builder and only written while unset; a differing on-chain value is logged and kept.
- `GAS_FEE_USDC_<SUFFIX>`: overrides Circle's documented gas fee for a Gateway source chain, used only while its `GATEWAY_VM_GAS_FEE` key is unset.
- `REENABLE_CURRENCIES`, `MIGRATION_REVIEWED`, `CONFIRM_DISABLE_ALL`: the Lighter planner's opt-ins, as in `configure-lighter-vm-payload-builder.ts`.
- `abandonedInboxes` (state file): inboxes of an abandoned run; `manifest-activate` revokes their Hub `OPERATOR_ROLE`, rate limiter `CONSUMER_ROLE` and store `WRITE_ROLE`; `verify` expects those roles until then.
- TON and Gateway chains the previous allocator does not serve (no registration in `inventory`'s `previousRegistrations`, such as prod's polygon-gateway, unregistered by manifest 086 when Arc became the Gateway source) are left out of `manifest-register`, reported as left out by `verify`, and not required by `manifest-cutover`. The redeploy reproduces the previous allocator, not the chains config, so it never re-enables a retired source.
- `RETIRED_REGISTRATIONS` (`inventory.ts`): per env, registrations of chains or depositories the env no longer serves. They stay on the previous allocator (gone at cutover) instead of failing `inventory`, as long as their live builder is still the declared one. Their depositories must be empty before cutover.
- `EXCLUDED_CHAINS` (`verify-deployment/constants.ts`): per env, dead chains still in the oracle chains config. The verifier and the redeploy skip them.
