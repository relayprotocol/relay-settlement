# Settlement Indexer

## Operational Checks

Run a sampled balance audit against the Relay chain:

```sh
DATABASE_URL=... RPC_HTTP_URL=... yarn workspace @relay-settlement/indexer audit:balances
```

Useful environment variables:

- `BALANCE_AUDIT_TOKEN_LIMIT`: number of tokens to sample, ordered by indexed transfer count. Defaults to `20`.
- `BALANCE_AUDIT_HOLDER_LIMIT`: number of top holders to sample per token. Defaults to `20`.
- `BALANCE_AUDIT_TOKEN_ID`: restricts the audit to one token.
- `BALANCE_AUDIT_ADDRESS`: restricts the audit to one address. Requires `BALANCE_AUDIT_TOKEN_ID`.

The command exits non-zero when any indexed balance differs from the chain's `balanceOf`.

## Transfer Replay

Run a bounded transfer replay when indexed balances drift from chain state:

```sh
DATABASE_URL=... RPC_HTTP_URL=... TRANSFER_REPLAY_FROM_BLOCK=... TRANSFER_REPLAY_TO_BLOCK=... yarn workspace @relay-settlement/indexer replay:transfers
```

The replay is idempotent. It inserts missing events, reconciles touched balances from on-chain `balanceOf`, and syncs token transfer counts from indexed events. It also takes a Postgres advisory lock so concurrent replay jobs fail fast.

For production repairs, pause the background worker before replaying and resume it after verification.
