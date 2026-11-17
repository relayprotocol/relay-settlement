# Settlement Indexer

## Build and test

`yarn build` and `yarn test` in this workspace build its shared SDK, network,
and ABI dependencies before compiling or testing the indexer. The root CI
build already prepares those dependencies, so it uses `yarn build:ci` and
`yarn test:ci` here to reuse their outputs. Run the root `yarn build:typescript`
before invoking these workspace CI commands directly.

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

## Transfer Statistics

`/api/transfers/stats` and `/api/tokens/:id/transfer-stats` cache their final
bucketed query results in each API process for 10 minutes. Equivalent query
parameters are normalized, and the rolling lower timestamp bound advances on
10-minute boundaries. Concurrent requests for the same result share one
database query. Cache read or write failures are logged as structured events
and fall back to PostgreSQL. The bounded in-memory cache evicts the least recently
used entry. Fixed timezone offsets retain minute precision and are clamped to
-720..840 minutes. Each process allows at most two statistics refreshes at once;
up to eight cold requests can wait for a slot for at most two seconds. Requests
with usable stale data return it immediately when refresh slots are occupied.
A failed refresh waits 30 seconds before retrying; the last successful
result can be served for up to 30 minutes from its query start time. Responses
include `updatedAt` and `stale`. When no usable result is available, the API
returns `503` with `Retry-After: 30`. Query durations, refresh failures, and stale
responses are logged; cache hits and coalesced requests use debug logs.

The UI refreshes charts separately from live events, once per minute after the
previous request finishes. Hidden tabs pause chart polling, failures honor
`Retry-After` or back off from one to ten minutes, and saved results remain
visible with a stale notice.

### Minute summaries and rollout

Migration `1790160000000_add_transfer_stats_minutes` adds an empty table of
per-token UTC-minute counts and a backfill checkpoint. Every successfully
inserted transfer increments its minute count in the same statement as its event
and token count. Duplicates increment nothing, rollback restores all three, and
historical replays update the event's original minute.

Apply the migration before running new writers. Replace **all** API, worker, and
CLI/replay instances with the new writer before starting the backfill. Old writers
do not maintain minute counts, so a mixed-version deployment must not enable
summary reads. Until backfill completion, statistics use raw events with string
formatting applied only after aggregation.

After verifying every writer has been replaced, run from a built checkout:

```sh
DATABASE_URL=... TRANSFER_STATS_WRITERS_READY=1 yarn workspace @relay-settlement/indexer backfill:transfer-stats
```

The acknowledgement is required. Backfill processes ten-minute windows in
batches of at most 100 token/minute keys, pauses 100 ms between batches, and
checkpoints each transaction. It locks summary rows before recounting events
with a fresh snapshot, preserving concurrent new-writer increments. Lock waits
are limited to two seconds and statements to eight seconds. If interrupted or
timed out, rerun the command to resume. Concurrent commands fail fast, including
reset attempts while backfill is running.

Completion sets `transfer_stats_backfill.completed_at`, enabling summary reads
on the next cache refresh. All granularities and fixed minute offsets retain
their existing bucket semantics; a partial first minute reads only that bounded
slice of raw events. Check the completion marker, compare sampled token/minute
counts with `events`, and verify chart counts, query latency, CPU, indexing lag,
and failed-event recovery through several cache refreshes.

Before rolling any writer back, stop an active backfill and reset its state:

```sh
DATABASE_URL=... yarn workspace @relay-settlement/indexer backfill:transfer-stats --reset
```

This disables summary reads and clears the checkpoint without deleting events
or counts. Cached charts retain their normal freshness limits. Keep the additive
tables while any new writer remains deployed. After all writers are upgraded
again, rerun the complete backfill before using summaries. Use the same reset
and backfill procedure for any direct event-history repair that bypasses
`insertEvent`: reset first, finish the history edits, then backfill. Backfill
reconciles keys from both events and existing summaries, including summaries
outside the remaining event range, and removes counts with no remaining events.

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

Some chains expose one physical balance twice: as the native asset and as an
ERC-20 facade that reads and moves the same balance (Arc USDC, Stable USDT0,
Celo, Metis). Each of those Hub tokens is compared against the full depository
balance, so each can read as covered while their combined supply exceeds it.
`SHARED_RESERVE_GROUPS` in `src/services/sharedReserves.ts` lists these pairs.
When at least two members of a group are indexed, the audit also emits a
`shared_reserve_check` entry that scales every member's supply to the largest
member decimals, sums it, and compares it with one depository balance read. A
shared-reserve deficit, or a failed member check, uses the error log level, and
the `audit_completed` entry reports `sharedReserveDeficits` and
`sharedReserveErrors`. Add a group only after confirming on-chain that the
facade's `balanceOf` equals the native balance and its `transfer` moves it.

## Transfer Replay

Run a bounded transfer replay when indexed balances drift from chain state:

```sh
DATABASE_URL=... RPC_HTTP_URL=... TRANSFER_REPLAY_FROM_BLOCK=... TRANSFER_REPLAY_TO_BLOCK=... yarn workspace @relay-settlement/indexer replay:transfers
```

The replay is idempotent. It inserts missing events, reconciles touched balances from on-chain `balanceOf`, and increments token transfer counts only for newly inserted events. It also takes a Postgres advisory lock so concurrent replay jobs fail fast.

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

## Transfer count migration and repair

Transfer insertion and the corresponding `tokens.transfers` increment now commit
in one statement. Duplicate events do not increment the count, and failed-event
and manual replays still reconcile chain state even when an event already exists.
Metadata is created before a token's first insert; if historical events predate
its metadata, token creation initializes their count once.

Before deploying this change, pause the background worker and prevent new admin
or CLI replays; let any active replay finish. Run migration
`1790110000000_initialize_transfer_counts` to initialize existing token counts.
It scans event history once and locks event/token writes while doing so. Replace
**all** old API and worker instances before enabling replays and resuming the
worker. An old writer's full-history recount can overwrite a concurrent increment.
Rolling back likewise requires pausing writers while switching versions; the
migration's down operation preserves the counts.

Normal ingestion and replay no longer recount event history. To explicitly repair
one existing token's transfer count:

```sh
DATABASE_URL=... TRANSFER_COUNT_TOKEN_ID=... yarn workspace @relay-settlement/indexer repair:transfer-count
```

This repair locks the token before counting in a separate statement, preserving
concurrent increments from the new writers. It may hold that token's writes while
scanning its history; use it as a bounded maintenance operation.

Log retrieval learns smaller block ranges after oversized responses and processes
at most 1,000 logs per page, including dense single-block cursor responses. The
response-size check requires an explicit message; rate-limit errors propagate
without retrying smaller ranges or changing the learned block count. The
checkpoint advances only after the final page of a range. Coverage audits persist
findings page by page and yield during decoding; partial findings from failed or
running audits are not presented as a completed report. Audit frequency and the
250-block overlap remain unchanged. Already indexed overlap events at or below
the checkpoint skip processing; events above it still reconcile after a crash.

Database integration tests use a dedicated PostgreSQL database and create/drop
an isolated schema. They are enabled in CI. To run them locally alongside the
indexer's unit tests:

```sh
INDEXER_TEST_DATABASE_URL=postgres://localhost/indexer_test yarn workspace @relay-settlement/indexer test
```

After rollout, verify audit event-loop delay, query timeouts, indexing lag, failed
event recovery, and sampled transfer counts under comparable traffic. Check that
full-history recounts no longer appear in routine ingestion/replay database load.
