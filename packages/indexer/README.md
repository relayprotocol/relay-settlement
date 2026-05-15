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

## Admin Transfer Replay API

The API can expose a restricted admin endpoint to trigger the same bounded replay without local DB access:

```sh
curl -X POST "$INDEXER_API_URL/api/admin/replay/transfers" \
  -H "x-api-key: $AUTH_API_KEY" \
  -H "content-type: application/json" \
  -d '{"fromBlock":1637552,"toBlock":1637584,"batchSize":2000,"reconcileChunkSize":100}'
```

The endpoint returns `202` with an in-memory job record. Poll job status with:

```sh
curl "$INDEXER_API_URL/api/admin/replay/transfers/$JOB_ID" \
  -H "x-api-key: $AUTH_API_KEY"
```

Admin replay configuration:

- `AUTH_API_KEY`: required API key used by both query and admin endpoints.
- `MAX_TRANSFER_REPLAY_BLOCK_RANGE`: maximum inclusive replay range accepted by the API. Defaults to `100000`.

The API trigger is asynchronous, range-limited, and uses the same Postgres advisory lock as the CLI replay. Job status includes the current block, processed/remaining blocks, percent complete, and replay counters.

Job status is kept in process memory for recent jobs. If the API process restarts during a replay, that job id may return `404`; because replay is idempotent and the advisory lock is released on disconnect, rerun the same bounded range to continue repair.

Example job progress:

```json
{
  "state": "running",
  "progress": {
    "currentBlock": 1639551,
    "lastBatchFromBlock": 1637552,
    "lastBatchToBlock": 1639551,
    "fromBlock": 1637552,
    "toBlock": 1647551,
    "totalBlocks": 10000,
    "processedBlocks": 2000,
    "remainingBlocks": 8000,
    "percentComplete": 20,
    "elapsedMs": 1534,
    "blocksPerSecond": 1303.781,
    "estimatedRemainingSeconds": 6.136,
    "decoded": 488,
    "inserted": 487,
    "skipped": 0,
    "reconciledAddresses": 330,
    "updatedAt": "2026-05-15T12:00:00.000Z"
  }
}
```
