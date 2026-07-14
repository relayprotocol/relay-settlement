# Chainlink ingester

Standalone oracle service that streams signed price reports from Chainlink Data
Streams and forwards them to the sequencer over a local IPC connection.

The service connects to Data Streams over a WebSocket, subscribes to a fixed set
of feeds, structurally verifies each signed report, caches the latest report for
each feed, and serves those reports to sequencer subscribers over a TCP
connection. Reports are decoded only to verify them (see below)
and then forwarded as opaque signed blobs.

## How it works

- On startup it opens an authenticated WebSocket to the configured Data Streams
  endpoint and subscribes to all `CHAINLINK_FEED_IDS`.
- Each incoming report's signed blob is verified (see below) and, if it passes,
  stored in an in-memory map keyed by feed, keeping only the latest payload per
  feed. Reports that fail are dropped and logged.
- It listens on the configured TCP address (`INGESTER_ADDRESS`) for
  sequencer connections and streams updates to them.
- The WebSocket reconnects automatically with exponential backoff (1s up to 30s)
  on transport errors.
- The ingester and the IPC listener run as independent tasks. If either stops
  with an error it is restarted in place after a short delay. On `SIGINT` or
  `SIGTERM` the service signals all tasks to stop and shuts down gracefully.

## IPC protocol

The connection speaks the `price-oracle-ipc` frame protocol over TCP.
A connected subscriber receives, in order:

- A `Hello` frame with the protocol version, provider id, and subscribed feeds.
- A snapshot of the latest cached report for every feed seen so far.
- Live `PriceUpdate` frames as new reports arrive.
- Periodic `Heartbeat` frames every `HEARTBEAT_INTERVAL` (5s, fixed by the protocol).

Multiple subscribers are served concurrently, up to a fixed connection limit;
connections beyond the limit are rejected. Each subscriber has an independent
view, and if one lags behind the broadcast buffer the full snapshot is resent to
it.

The provider id is `keccak256("chainlink")`.

## Verification

Verification is split between this service and the on-chain Data Streams verifier.

The on-chain verifier performs the trust check. It recovers the DON oracle
signatures over the report and enforces the configured signer set and threshold
before a price is trusted. That requires the signer set and stays on-chain.

Before caching a report this service performs the checks that do not require the
signer set, using the official `chainlink-data-streams-report` crate to decode
the report. It confirms the report is a V3 (crypto) schema, decodes the full
report envelope and the V3 body, and checks that the report carries the requested
feed, that its timestamps are coherent (`validFrom ≤ observations ≤ expiresAt`)
and fresh (not expired, not implausibly future-dated, and within
`CHAINLINK_MAX_AGE_SEC`), and that the benchmark price is positive and inside the
`bid`/`ask` band. Reports that fail any check are dropped and logged, so
malformed, mis-keyed, stale, or expired reports are never forwarded. A report
whose schema is not V3 is rejected as unsupported.

This is an integrity check, not a trust check. A report that passes here can
still be rejected by the on-chain verifier, which alone proves authenticity by
checking the DON signatures against the signer set. Dropping reports that would
revert on-chain (expired or malformed) keeps them from reaching the sequencer.
The report bytes are forwarded exactly as received; decoding happens only to
validate them.

## Authentication

Requests to Data Streams are signed with HMAC-SHA256 over the method, path,
body hash, API key, and a millisecond timestamp.
The signature is sent via the `Authorization`, `X-Authorization-Timestamp`, and
`X-Authorization-Signature-SHA256` headers.
The API secret is never logged.

## Configuration

Configuration is defined via environment variables.
A `.env` file in the working directory is loaded if present.
The `.env.example` contains example values.

- `CHAINLINK_DATA_STREAMS_API_KEY` - required, Data Streams API key.
- `CHAINLINK_DATA_STREAMS_API_SECRET` - required, Data Streams API secret.
- `CHAINLINK_WS_ENDPOINT` - required, WebSocket endpoint, for example `wss://ws.dataengine.chain.link` (mainnet) or `wss://ws.testnet-dataengine.chain.link` (testnet).
- `CHAINLINK_FEED_IDS` - required, comma-separated 32-byte hex feed ids (`0x` prefix optional).
- `CHAINLINK_MAX_AGE_SEC` - optional, freshness window in seconds for a report's observations timestamp, defaults to 300. Reports older than this are dropped.
- `INGESTER_ADDRESS` - TCP listen address, defaults to `127.0.0.1:9801`.
- `RUST_LOG` - optional, tracing filter, defaults to `info`.

## How to build

Copy the example environment file, fill in the credentials, and run the binary.

```sh
cp .env.example .env # Edit as necessary
cargo build --release --bin chainlink-ingester
./target/release/chainlink-ingester
```
