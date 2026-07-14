# Pyth ingester

Standalone oracle service that streams signed Pyth price updates from Hermes and
forwards them to sequencer subscribers over a TCP connection.

The service opens one Server-Sent Events stream per feed against Hermes, caches
the latest signed accumulator blob for each feed, and serves those blobs to
sequencer subscribers over a TCP connection. Each blob is structurally
verified before it is cached, then forwarded opaquely.

## How it works

- On startup it opens one SSE stream per feed in `PYTH_FEED_IDS` against the
  configured Hermes endpoint (`/v2/updates/price/stream?ids[]=<feed>`).
- Each incoming update's signed blob is verified (see below) and, if it passes,
  stored in an in-memory map keyed by feed, keeping only the latest payload per
  feed.
- It listens on the configured TCP address (`INGESTER_ADDRESS`) for
  sequencer connections and streams updates to them.
- Each per-feed stream reconnects automatically with jittered exponential backoff
  (1s up to 30s). Pyth closes idle SSE streams periodically, so reconnects are
  routine. The jitter keeps feeds from reconnecting in lockstep and tripping the
  Hermes rate limit.
- The ingester and the IPC listener run as independent tasks. If either stops
  with an error it is restarted in place after a short delay. On `SIGINT` or
  `SIGTERM` the service signals all tasks to stop and shuts down gracefully.

## IPC protocol

The connection speaks the `price-oracle-ipc` frame protocol over TCP.
A connected subscriber receives, in order:

- A `Hello` frame with the protocol version, provider id, and subscribed feeds.
- A snapshot of the latest cached blob for every feed seen so far.
- Live `PriceUpdate` frames as new updates arrive.
- Periodic `Heartbeat` frames every `HEARTBEAT_INTERVAL` (5s, fixed by the protocol).

Multiple subscribers are served concurrently, up to a fixed connection limit;
connections beyond the limit are rejected. Each subscriber has an independent
view, and if one lags behind the broadcast buffer the full snapshot is resent to
it.

The provider id is `keccak256("pyth")`.

## Verification

Verification is split between this service and the on-chain Pyth contract.

The on-chain contract performs the trust check. It verifies the Wormhole guardian
signatures over the Merkle root before a price is trusted. That requires the
guardian set and stays on-chain.

Before caching a blob this service performs the checks that do not require the
guardian set, using the official `pythnet-sdk` types. It parses the accumulator
update, extracts the Merkle root from the embedded VAA, verifies each price
update's Merkle proof against that root, and confirms the requested feed is
present. Blobs that fail are dropped and logged, so malformed, truncated, or
mis-keyed updates are never forwarded.

This is an integrity check, not a trust check. Because the Merkle root is taken
from the blob's own VAA, it confirms the blob is well-formed and internally
consistent but does not prove authenticity. Only the on-chain guardian signature
check does that.

## Configuration

Configuration is defined via environment variables.
A `.env` file in the working directory is loaded if present.
The `.env.example` contains example values.

- `HERMES_ENDPOINT` - optional, Hermes base URL, defaults to `https://hermes.pyth.network`.
- `HERMES_API_KEY` - optional, sent as a bearer token. Hermes is currently
  keyless. A Pyth Core API key can be set here without code changes.
- `PYTH_FEED_IDS` - required, comma-separated 32-byte hex Pyth feed ids (`0x` prefix optional).
- `INGESTER_ADDRESS` - TCP listen address, defaults to `127.0.0.1:9802`.
- `RUST_LOG` - optional, tracing filter, defaults to `info`.

## How to build

Copy the example environment file, fill in the feeds, and run the binary.

```sh
cp .env.example .env # Edit as necessary
cargo build --release --bin pyth-ingester
./target/release/pyth-ingester
```
