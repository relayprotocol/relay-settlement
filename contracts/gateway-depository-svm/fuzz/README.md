# Relay gateway depository property tests

Runs generated transfers and deposits against the compiled gateway depository
and the Circle Gateway programs in-process on
[LiteSVM](https://github.com/LiteSVM/litesvm), and checks where the funds ended
up after every transaction.

Each case picks a plain transfer, a routed transfer or a deposit, the amount,
what a third party sent to the vault and to the replay accounts beforehand, and
how close the request is to its expiration, and optionally one change to the
transaction: a request the allocator did not sign or that was changed after
signing, a signed request for another domain or token, accounts that pay
another recipient, a request at or past its expiration, an expired
attestation, an attestation for another amount, caller or recipient, a
replayed request or transfer spec, a missing, misplaced or shared ed25519
instruction, two signed requests in one transaction, a routed transfer without
its router, or another account in one of the account slots.

## Run

Build the program, the router stand-in from `../depository-svm`, and download
the Circle Gateway fixtures first (see `../README.md`):

```bash
(cd .. && yarn build && yarn fetch:fixtures)
(cd ../../depository-svm && yarn build:fixtures)
```

```bash
FUZZ_CASES=300000 cargo test --release -- --nocapture
```

- `survey` runs `FUZZ_CASES` cases (default 2000) from `FUZZ_SEED` (default 0),
  prints a tally per case kind and the highest compute unit use, and fails on
  the first case of every broken property. `FUZZ_INDEX=<n>` replays one case of
  the seed with its program logs.
- `DEPOSITORY_SO`, `CALLER_SO`, `GATEWAY_MINTER_SO` and `GATEWAY_WALLET_SO` point
  the tests at other builds of the programs.

## Not covered

`initialize`, `sweep` and the owner settings (the state is written directly),
the ed25519 instruction layout beyond a missing, misplaced or shared one, and
the real `relay-router` (a stand-in calls the routed transfer).

## Checked after every transaction

- A transfer pays the recipient exactly the allocator-signed amount, out of
  Circle's custody, and only when the allocator signed that exact request.
- Every changed case fails and moves nothing; an unchanged one succeeds
  whatever a third party sent to the vault or the replay accounts.
- The `used_request` account is flagged used, and Circle's replay account
  exists, exactly when the transfer was paid; neither the request nor the
  transfer spec pays twice.
- A request executes up to the second before its expiration and never at or
  after it.
- A routed transfer only executes when its router calls the depository
  directly.
- A deposit takes exactly the amount from the sender and adds it to the
  allocator's Circle Gateway balance, and fails while deposits are disabled.
- The vault balance never changes, and a third party never gains tokens or a
  Circle Gateway balance.
