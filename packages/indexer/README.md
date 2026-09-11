# Settlement Indexer

## Token USD Prices

`POST /api/token-prices` accepts up to 200 Hub token ids and returns the
current `RelayPriceOracle` route and USD-price status for each token. Route
configuration, adapter configuration, and current price availability are
reported separately so a stale or temporarily unavailable price is not shown
as an unconfigured feed. Exact fixed-point values and timestamps are returned
as decimal strings.

The API simulates `resolveUsdPrice(uint256)` through the configured Relay RPC;
it never sends a transaction. Results are cached in each API process for up to
five seconds and never beyond the price expiration. Concurrent reads for the
same token share one RPC request.

The production price-oracle address defaults from
`@relay-protocol/settlement-networks`. Set
`PRICE_ORACLE_CONTRACT_ADDRESS` to override it for another deployment.

## Transfer Statistics Cache

`/api/transfers/stats` and `/api/tokens/:id/transfer-stats` cache their final
bucketed query results in each API process for 10 minutes. Equivalent query
parameters are normalized, and the rolling lower timestamp bound advances on
10-minute boundaries. Concurrent requests for the same result share one
database query. Cache read or write failures are logged as structured events
and fall back to PostgreSQL.

## Depository Balance Audit

Worker pods compare supported indexed currencies' Hub total supply with their
underlying depository balance every 10 minutes. Chain and production
depository metadata comes from `$ORACLE_API_URL/chains/v1`; currency metadata
comes from `RelayHub.tokenMetadata` and is cached on the `tokens` row.

Set `ORACLE_API_URL` to the Oracle service base URL and `ORACLE_API_KEY` to a
valid Oracle API key. The worker sends the key in the `x-api-key` header on
`/chains/v1` requests. If the key is unset or empty, the header is omitted.
This is separate from `AUTH_API_KEY`, which protects the indexer's own API.

Configure an RPC for each chain containing an indexed currency. Environment
variable names use the
uppercased Oracle chain id followed by `_RPC_URL`, for example `BASE_RPC_URL`
and `ARBITRUM_NOVA_RPC_URL`.

`DEPOSITORY_BALANCE_AUDIT_INTERVAL_MS` overrides the default `600000` ms
interval. All audit lifecycle and currency-check logs are emitted as JSON. A
currency-check entry includes its `auditStatus`, Oracle `chainId`, token
metadata, and amounts as decimal strings formatted using the token's
`decimals`. The
corresponding integer values are retained in `deltaBaseUnits`,
`depositoryBalanceBaseUnits`, and `totalSupplyBaseUnits`. Deficits and
configuration or RPC errors use the error log level. The audit currently
supports Ethereum VM native and ERC-20 currencies, Solana VM native and SPL
currencies, Bitcoin, native TON, Tron native and TRC-20 currencies, native XRP,
Hyperliquid perps and spot assets, and Lighter assets. The JSON logger reserves
`status` for the log severity recognized by Datadog.

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

## Transfer Coverage Audit

When `DO_BACKGROUND_WORK=1`, the indexer compares recent confirmed `RelayHub.Transfer` logs with indexed `events`.

Audit findings are written to `indexer_audit_findings` and exposed through `/api/health` and `/api/audits/indexer/latest`. Confirmed findings include suggested replay ranges, but replay stays manual through the admin replay API/UI.

Sync health only becomes unhealthy after the configured number of consecutive completed audit runs have confirmed findings, or when the latest audit is stale or failed.

Worker readiness reports whether the configured API and background worker roles are running. Historical backfill, checkpoint lag, pending `failed_events`, and audit health do not remove an otherwise running worker from service. These strict operational signals remain visible through `/sync-health`, `/api/health`, and `/api/audits/indexer/latest`.

Useful environment variables:

- `TRANSFER_COVERAGE_AUDIT_LOOKBACK_BLOCKS`: confirmed Hub transfer window checked for missing indexed logs. Defaults to `5000`.
- `INDEXER_AUDIT_INTERVAL_MS`: background audit interval. Defaults to `900000`.
- `INDEXER_AUDIT_MAX_AGE_MS`: max age before audit health is stale. Defaults to `1800000`.
- `INDEXER_AUDIT_CONSECUTIVE_FAILURES`: consecutive completed audit runs required before confirmed findings fail health. Defaults to `2`.
- `INDEXER_AUDIT_FAILURE_THRESHOLD`: confirmed finding count per run that counts toward audit health failure. Defaults to `1`.

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
