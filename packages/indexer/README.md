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

## Transfer Ingestion Safety

The background worker waits for `CONFIRMATION_BLOCKS` before processing new logs and re-scans the last `TRANSFER_OVERLAP_BLOCKS` Hub transfer blocks on each poll. Transfer processing is idempotent: events are inserted once, then touched addresses are reconciled against on-chain `balanceOf` and token `totalSupply`.

Health lag is measured against the confirmed indexing target (`latestChainBlock - CONFIRMATION_BLOCKS`), not the unconfirmed chain head.

Useful environment variables:

- `CONFIRMATION_BLOCKS`: number of latest chain blocks to leave unindexed until they are less likely to be reorganized. Defaults to `12`.
- `TRANSFER_OVERLAP_BLOCKS`: number of Hub transfer blocks to re-scan from the checkpoint on each poll. Defaults to `250`.

## Indexer Drift Audits

When `DO_BACKGROUND_WORK=1`, the indexer runs persisted drift audits in the background:

- Balance drift audit: compares positive indexed `balances` rows with `RelayHub.balanceOf(address, tokenId)` at the Hub transfer checkpoint.
- Transfer coverage audit: compares recent confirmed `RelayHub.Transfer` logs with indexed `events`.

Audit findings are written to `indexer_audit_findings` and exposed through `/api/health` and `/api/audits/indexer/latest`. Confirmed findings include suggested replay ranges, but replay stays manual through the admin replay API/UI.

Confirmed balance drift findings are also queued in `indexer_reconciliation_jobs` for a bounded state-based repair. This only calls `RelayHub.balanceOf`/`totalSupply` for already-indexed token/address rows and updates current balance state. It does not insert missing historical events or automatically replay block ranges.

Sync health only becomes unhealthy after the configured number of consecutive completed audit runs have confirmed findings, or when the latest audit is stale or failed. Pending near-head findings are tracked for debugging without failing health.

Worker readiness does not depend on audit health. The readiness probe still checks runtime state, checkpoint lag, and pending `failed_events`, but skips audit health so an expensive or stale audit cannot remove otherwise running workers from service. Audit failures remain visible through `/sync-health`, `/api/health`, and `/api/audits/indexer/latest`.

Useful environment variables:

- `BALANCE_DRIFT_AUDIT_ENABLED`: enables the balance drift audit. Defaults to `true`.
- `BALANCE_DRIFT_AUDIT_BATCH_SIZE`: number of balance rows checked concurrently. Defaults to `25`.
- `BALANCE_DRIFT_AUDIT_GRACE_BLOCKS`: blocks near the audit checkpoint classified as pending instead of confirmed. Defaults to `250`.
- `TRANSFER_COVERAGE_AUDIT_LOOKBACK_BLOCKS`: confirmed Hub transfer window checked for missing indexed logs. Defaults to `5000`.
- `INDEXER_AUDIT_INTERVAL_MS`: background audit interval. Defaults to `900000`.
- `INDEXER_AUDIT_MAX_AGE_MS`: max age before audit health is stale. Defaults to `1800000`.
- `INDEXER_AUDIT_CONSECUTIVE_FAILURES`: consecutive completed audit runs required before confirmed findings fail health. Defaults to `2`.
- `INDEXER_AUDIT_FAILURE_THRESHOLD`: confirmed finding count per run that counts toward audit health failure. Defaults to `1`.
- `INDEXER_DRIFT_AUTO_RECONCILE_ENABLED`: enables bounded auto-reconciliation for confirmed balance drift. Defaults to `true`.
- `INDEXER_DRIFT_AUTO_RECONCILE_BATCH_SIZE`: max reconciliation jobs claimed after an audit run. Defaults to `25`.
- `INDEXER_DRIFT_AUTO_RECONCILE_STALE_MS`: age after which a running reconciliation job can be retried. Defaults to `600000`.

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
