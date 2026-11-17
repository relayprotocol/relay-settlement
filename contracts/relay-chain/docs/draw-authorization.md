# Draw authorizations

A funding-pool draw needs two things the pool checks itself: the account's
standing draw config (how much it will fund) and a statement from the
account's configured `authorizer` that one order may draw it through one exact
execution plan. This document is the signing and encoding reference for that
statement, `DrawAuthorization`, as verified by `FundingPool.debit`.

## What is signed

EIP-712 domain: `name = "FundingPool"`, `version = "1"`, the settlement
chain ID, and the pool the leg draws from as `verifyingContract`. Each pool is
its own domain, so a leg in another pool needs its own signature.

```text
DrawAuthorization(address account,address orderAddress,bytes32 planHash,uint256 nonce,uint256 deadline)
```

| Field          | Value                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`      | Pool account the leg draws from                                                                                                                                                                   |
| `orderAddress` | `ExecuteAndWithdrawRequest.orderAddress`; per-order draw records and the per-order cap key on it                                                                                                  |
| `planHash`     | `keccak256(executionData)`, where `executionData = abi.encode(PoolDrawResolver.Execution)`: every leg, every sandbox call, the surplus recipient and the salt. SDK: `getPoolDrawResolverPlanHash` |
| `nonce`        | The pool's `drawNonces(account)` at signing time                                                                                                                                                  |
| `deadline`     | Last valid Unix timestamp, inclusive. Zero is always expired                                                                                                                                      |

The plan hash is the same value the oracle-signed request nonce commits to
(`keccak256(resolver ‖ keccak256(executionData))`), so the oracle attestation,
the resolver's commitment check and the authorizer's signature all name one
plan. The resolver passes that hash to the pool in the `DrawRequest`, like the
amount, order and leg index it already supplies; the pool trusts `RESOLVER_ROLE`
holders for those fields and this one adds no new trust.

## Lifetime

The nonce is the account's draw nonce, the same value that orders the
account's signed config updates (each of which carries exactly
`drawNonces(account) + 1`). It moves on every change to the account's
guardrails, signed or direct, to any token or resolver, and on
`revokeDrawAuthorizations`. Every move voids every draw authorization signed
against the previous value, and emits `DrawNonceAdvanced(account, nonce)`
so relayers can drop cached signatures and re-sign in-flight orders.

Guardrail changes step the nonce by one, so its next values are predictable,
and an authorizer can hold signatures for any nonce it can guess. Revocation
therefore moves the nonce to an account-chosen value, between
`MIN_DRAW_NONCE_JUMP` (2^32) and `MAX_DRAW_NONCE_JUMP` (2^64 - 1) above the
current one, measured when the revocation executes. **Pick it at random**,
with the SDK's `getRandomFundingPoolRevocationNonce(drawNonces(account))`,
which draws the jump from `[2 * MIN_DRAW_NONCE_JUMP, MAX_DRAW_NONCE_JUMP]`
(2^33 to 2^64 - 1): a random jump lands where no authorization was
pre-signed, so revocation kills every outstanding one. A predictable jump gives no protection at all; `+1` is refused on-chain,
but a fixed `+2^32` is just as guessable and is not. The epoch is no
substitute either: it also only ever steps by one, so authorizations
pre-signed for the next epochs would survive a revocation that relied on it.

Within its lifetime one authorization funds every leg of its plan that names
the account: legs sharing a pool and account carry the same envelope. Replay
is bounded by the pool's per-order draw records, one draw per
`(orderAddress, account, legIndex)`, and by the per-order cap, exactly as
before.

## Cancelling queued account updates

Account-signed config and resolver updates carry two counters:

- `epoch`: the current `configEpoch(account)`.
- `nonce`: the next `drawNonces(account) + 1`.

A pre-signed batch uses the **same current epoch** and consecutive nonces for
all entries. Applying an ordinary signed update advances only the nonce. Every
direct config or resolver change, and either `revokeDrawAuthorizations`
overload, advances both counters. This rejects every queued update from the
old epoch, including a grant whose future nonce becomes next after revocation.
`DrawConfigEpochAdvanced(account, epoch)` tells relayers to discard those
queued updates. Signers must read the current epoch; never pre-sign updates
for a predicted future epoch.

The EIP-712 types share the pool domain described above:

```text
DrawConfigUpdate(address account,address token,address authorizer,uint256 perOrderCap,uint256 budget,uint64 expiry,uint256 epoch,uint256 nonce,uint256 deadline)
DrawResolverUpdate(address account,address resolver,bool allowed,uint256 epoch,uint256 nonce,uint256 deadline)
DrawRevocation(address account,uint256 epoch,uint256 nonce,uint256 deadline)
```

An account that cannot transact directly, including an ERC-1271 wallet, can
sign `DrawRevocation` with its current epoch, a random new nonce
(`getRandomFundingPoolRevocationNonce`) and a deadline.
Anyone can relay it through `revokeDrawAuthorizations(revocation, signature)`.
The SDK exports `fundingPoolDrawRevocationTypes` and
`getFundingPoolDrawRevocationHash`; the pool exposes
`hashDrawRevocation`. Revocation remains available while the pool is
paused and changes neither the stored guardrails nor the current authorizer.
It invalidates existing draw signatures; the authorizer can still sign new
ones under the new nonce.

An ordinary signed config or resolver update does **not** cancel other queued
updates in its epoch. To cancel pending grants before replacing guardrails,
relay an explicit revocation, wait for confirmation, then read the new epoch
and nonce and sign fresh updates. Signed revocation names a target nonce rather
than the current one, and the pool checks the jump bounds when the revocation
executes: it is valid while
`MIN_DRAW_NONCE_JUMP <= target - drawNonces(account) <= MAX_DRAW_NONCE_JUMP`.
Queued grants may therefore advance the current nonce without invalidating the
pending revocation until they bring the remaining gap under the minimum; a
target at exactly `+2^32` dies on the first queued advance, which is why the
SDK draws jumps from `2^33` up, leaving `2^32` advances of slack. If a
revocation does fail with `InvalidRevocationNonce`, re-sign it from the new
nonce. On success, revocation increments the epoch and moves the nonce to the
target; the epoch change prevents replay. This does not undo grants or draws already
executed before revocation, or disable the stored authorizer.

## Configuring a contract-wallet account

`setup-pool-account.ts --account <address> --cap <value> --print-messages`
prints the messages and digests without requiring a signing key or signatures.
`--dry-run` likewise stops before signing or broadcasting. Both batch messages
use the pool's current epoch. If the resolver is already allowlisted, only a
config message is printed and only `--config-signature` is needed on rerun.
Otherwise provide both `--resolver-signature` and `--config-signature`.

Keep the printed options and nonce, and pass `--deadline-at <printed deadline>`
when relaying the externally signed messages. This preserves the signed digest
as new blocks arrive. `--deadline <seconds>` selects a relative validity window
when first preparing messages. Set `RELAYER_PRIVATE_KEY` to pay transaction
gas. If the epoch or nonce changes before submission, prepare fresh messages
and obtain new signatures.

## Encoding

Each entry of the resolver payload's `bytes[] authorizations` is

```text
abi.encode(DrawAuthorization authorization, bytes signature)
```

one per leg in index order (SDK: `encodeFundingPoolDrawAuthorization`). The
signature is EIP-712 over `FundingPool.hashDrawAuthorization` by the
token's configured authorizer, EOA or ERC-1271. The outer payload is unchanged:
`abi.encode(bytes executionData, bytes[] authorizations)`, with the oracle
commitment covering `executionData` only, so authorizations are still signed
after attestation, once the order address is known, without moving the
commitment.

## Relayer flow

1. Compose the `Execution`, encode it, and obtain the oracle attestation over
   `getPoolDrawResolverCommitmentNonce(resolver, executionData)`.
2. Once the order address is known, read `drawNonces(account)` from
   each leg's pool, pick a deadline, and have each account's authorizer sign
   `DrawAuthorization{account, orderAddress, keccak256(executionData), nonce, deadline}`.
3. Wrap each signature with `encodeFundingPoolDrawAuthorization` and attach
   them with `encodePoolDrawResolverData`.
4. On `DrawNonceAdvanced` for an account, or a
   `DrawAuthorizationNonceMismatch` / `DrawAuthorizationExpired` revert,
   re-sign that account's in-flight authorizations. A
   `DrawAuthorizationPlanMismatch` revert means the payload's plan is not the
   one the authorizer signed.

## Resolver-side checks

Independently of the signature, `PoolResolverBase` refuses a fixed leg that
runs sandbox calls with a zero `amountOutMinimum` (`ZeroDrawLegMinimum`), and
requires a same-token conversion leg to return at least the amount it drew, so
a leg cannot forward drawn funds and satisfy its floor with dust.

## Migration

This is a breaking pool, resolver and SDK change: the `DrawAuthorization`
typehash, the authorization envelope and the `DrawRequest` struct all changed.
Pools and resolvers are deployed as full contracts, so a new pool and resolver
pair is deployed together; funding pool accounts re-sign their configs and allowlists for
the new pool's domain, and authorizers issue fresh signatures in the new shape.
The signed config and resolver update shapes also include `epoch`; signatures
from the previous shapes are incompatible. `setup-pool-account.ts` reads the
current epoch and next nonce from the pool.
