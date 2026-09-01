# Stork ingester

Oracle service that streams signed price updates from the Stork Fast API and forwards them to the sequencer over local IPC.

Fast signs a whole batch of assets with one signature, so the service opens a single WebSocket subscribed to all configured assets and forwards the batch payload under each feed it contains.
Each payload is validated and forwarded verbatim, since the bytes are already the input to the Stork Fast contract's `verifySignedECDSAPayload`.

## How it works

- Feeds are configured as `SYMBOL=assetId` pairs under a single `STORK_TAXONOMY`. The asset id and taxonomy are authoritative; the symbol is a label.
- On startup it fetches `GET <endpoint>/v1/taxonomy` and validates the config against it:
  The taxonomy id must match, every configured symbol must exist, and each symbol's asset id must agree with the taxonomy.
- The fetch is retried a few times for transient failures; a validation mismatch exits immediately.
- It opens one authenticated WebSocket at `/ws?channel=<channel>&message_type=signed_ecdsa` and subscribes to all configured asset ids.
- Each frame carries one signed batch. Valid batches are cached under each configured feed present in them, keeping only the latest nanosecond timestamp per feed. Older updates and conflicting values at the same timestamp are dropped and logged.
- It listens on `INGESTER_ADDRESS` for sequencer connections and streams updates to them.
- The connection reconnects with exponential backoff (1s to 15s). The backoff resets once a connection delivers a valid payload, so only connections that never produce data keep escalating.
- On a fixed channel, a watchdog reconnects the socket if it is silent for 5 seconds, catching dead connections.
- If frames keep arriving but a subscribed asset is absent from every batch for twice the idle timeout, the connection is treated as failed and resubscribes.
- The ingester and listener run as independent tasks, each restarted on error. `SIGINT` or `SIGTERM` triggers a graceful shutdown.
- A stats line is logged every 15 seconds, including socket status and cached feeds versus configured feeds.

## Payload

The payload is the raw `signed_ecdsa` bytes, forwarded as received.
Byte layout from `StorkFastDeserialize.sol`:

```
[0:65]   signature   (r 32 | s 32 | v 1, where v is 0/1)
[65:67]  taxonomyID  (uint16)
[67:75]  timestampNs (uint64), one timestamp for the whole batch
[75:..]  assets[], 18 bytes each: assetID (uint16) | quantizedValue (int128, 16B)
```

The sequencer submits these bytes to `verifySignedECDSAPayload`, which verifies inline (the contract stores nothing).
The payload keeps the nanosecond timestamp, and the IPC frame's `source_time_ms` is the same value in Unix milliseconds.

## IPC protocol

Subscribers connect over TCP and speak the `price-oracle-ipc` frame protocol, receiving in order:

- A `Hello` frame with the protocol version, provider id, and subscribed feeds.
- A snapshot of the latest update per feed.
- Live `PriceUpdate` frames.
- Periodic `Heartbeat` frames every `HEARTBEAT_INTERVAL` (5s, fixed by the protocol).

The provider id is `keccak256("stork")` and feeds are keyed by `keccak256(taxonomyId || assetId)` (big-endian uint16 pair).
The on-chain `StorkFastAdapter` recomputes the same hash from the payload's own taxonomy and asset ids, so the feed binding is self-certifying and needs no on-chain configuration.
This differs from Stork's Core `keccak256(symbol)` encoding, so routes are re-registered when switching tiers.

## Verification

The ECDSA signature is verified on-chain by `verifySignedECDSAPayload`, not here.
The signer address is set by on-chain registration and can rotate, so the ingester forwards the signed bytes intact instead of tracking it.

Before caching, each payload is checked:

- Its `taxonomyID` matches the taxonomy resolved at startup.
- Each asset id appears only once in the batch.
- It is fresh, not older than `STORK_MAX_AGE_SEC` and no more than 6 seconds ahead of the ingester host's Unix clock.

Failing payloads are dropped and logged.
Assets in the batch that are not configured feeds are ignored.
Values are `int128`, scaled by 10^18, and may be negative.

## Authentication

The WebSocket handshake sends `Authorization: Basic <STORK_API_KEY>`.

## Configuration

All configuration is via environment variables, loaded from a `.env` file if present.

- `STORK_WS_ENDPOINT` - required, Fast WebSocket base URL, for example `wss://fast.jp.stork-oracle.network`. The `/ws` path and query are appended.
- `STORK_API_KEY` - required, Stork Fast API key, sent as `Authorization: Basic <key>`.
- `STORK_FEED_IDS` - required, comma-separated `SYMBOL=assetId` pairs, for example `BTCUSD=1,ETHUSD=2,SOLUSD=3`. The asset id is authoritative, the symbol is a label validated against the taxonomy at startup.
- `STORK_TAXONOMY` - required, the uint16 taxonomy id the asset ids belong to. Validated against the taxonomy endpoint at startup.
- `STORK_CHANNEL_TYPE` - optional, delivery cadence, defaults to `500ms` (also `10ms`, `20ms`, `50ms`, `100ms`, `1s`, or `real_time`).
- `STORK_COMPRESSION` - optional, offer permessage-deflate, defaults to `true`. The Stork gateway requires it, so disable only for a bespoke instance.
- `STORK_MAX_AGE_SEC` - optional, freshness window in seconds, defaults to 30.
- `STORK_IDLE_TIMEOUT_SEC` - optional, idle watchdog in seconds, 0 disables. Defaults to 5 seconds on fixed channels, off on `real_time`.
- `INGESTER_ADDRESS` - TCP listen address, defaults to `127.0.0.1:9804`.
- `RUST_LOG` - optional, tracing filter, defaults to `info`.
- `OTEL_EXPORTER_ENABLE` - optional, enable OTLP telemetry export, defaults to `false`.
- `OTEL_EXPORTER_ENDPOINT` - required when export is enabled, OTLP/HTTP base URL. The `/v1/traces`, `/v1/metrics`, and `/v1/logs` paths are appended.
- `OTEL_SERVICE_NAME` - optional, exported `service.name`, defaults to `stork-ingester`.
- `OTEL_EXPORTER_BEARER_TOKEN` - optional, sent as `Authorization: Bearer <token>`, for an OpenTelemetry collector endpoint.
- `OTEL_EXPORTER_DD_API_KEY` - optional, sent as `dd-api-key: <key>`, for direct export to the Datadog OTLP intake.

## How to build

Copy the example environment file, fill in the credentials, and run the binary.

```sh
cp .env.example .env # Edit as necessary
cargo build --release --bin stork-ingester
./target/release/stork-ingester
```
