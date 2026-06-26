# RedStone ingester

Standalone oracle service that pulls signed RedStone data packages from a
RedStone gateway, assembles the canonical RedStone payload for each feed, and
forwards those payloads to the sequencer over a local IPC connection.

Unlike Chainlink Data Streams and Pyth, where one feed maps to a single signed
blob, a RedStone price is backed by several independent signer nodes. The
service polls the gateway, verifies each signer's data package, assembles the
self-contained RedStone payload that the on-chain RedStone verifier consumes,
caches the latest payload per feed, and serves it to a single sequencer
subscriber over an IPC connection (TCP by default).

## How it works

- On startup it builds a client for the configured RedStone gateway and begins
  polling `GET {REDSTONE_GATEWAY_URL}/data-packages/latest/{REDSTONE_DATA_SERVICE_ID}`
  every `REDSTONE_POLL_INTERVAL_MS`. A single request returns the latest signed
  packages for every feed of the data service.
- For each configured feed (`REDSTONE_FEED_IDS`) it takes the feed's packages,
  serializes each one to RedStone's canonical byte layout, recovers the signer
  from that serialization, and compares it to the signer address the gateway
  reported. It also checks the package actually carries the requested feed and
  that the value is positive. Packages that fail any check are dropped.
- It keeps only the packages that share the newest timestamp and requires that
  timestamp to be within a freshness window, dropping stale or future updates.
- If at least `REDSTONE_MIN_SIGNERS` unique signers remain, it assembles the
  canonical RedStone payload (`signed data packages ‖ unsigned metadata ‖
  marker`) and stores it in an in-memory map keyed by feed, keeping only the
  latest payload per feed.
- It listens on the configured endpoint (`INGESTER_TRANSPORT`, TCP by default)
  for a sequencer connection and streams updates to it.
- Gateway errors retry with jittered exponential backoff (1s up to 30s).
- The ingester and the IPC listener run as independent tasks. If either stops
  with an error it is restarted in place after a short delay. On `SIGINT` or
  `SIGTERM` the service signals all tasks to stop and shuts down gracefully.

## IPC protocol

The connection speaks the `price-oracle-ipc` frame protocol, over TCP or a Unix
socket depending on `INGESTER_TRANSPORT`.
A connected subscriber receives, in order:

- A `Hello` frame with the protocol version, provider id, and subscribed feeds.
- A snapshot of the latest cached payload for every feed seen so far.
- Live `PriceUpdate` frames as new payloads are assembled.
- Periodic `Heartbeat` frames every `INGESTER_HEARTBEAT_SEC`.

Only one subscriber is served at a time.
Additional connection attempts are rejected while a subscriber is connected.
If a subscriber lags behind the broadcast buffer, the full snapshot is resent.

The `PriceUpdate` payload is the canonical RedStone payload bytes, forwarded
opaquely. The `ingested_at` timestamp is the time the ingester received the
update (seconds).

The provider id is `keccak256("redstone")`.

## Verification

Verification is split between this service and the on-chain RedStone verifier.

This service does not perform the on-chain aggregation. It assembles and
forwards the canonical RedStone payload exactly as the on-chain RedStone verifier
expects to read it. The consumer (sequencer / on-chain verifier) recovers the
signers, enforces the authorized-signer threshold, and takes the median before
trusting a price. The signer set and threshold are properties of the on-chain
RedStone verifier, not of this service.

RedStone signatures are computed over RedStone's exact data-package
serialization, so a single byte-layout or value-scaling mistake would silently
break signature recovery on-chain. To prevent that, the ingester recovers each
signer from its own serialization before caching. If our bytes recover the
gateway-reported signer, the same bytes will recover on-chain. Anything that does
not verify is dropped, so a payload that would revert on-chain cannot leave
the ingester. Numeric values are read from the gateway as raw JSON (no
floating-point rounding) and scaled by `10^8`, matching the integer the signer
signed.

A few sanity checks run alongside signer recovery, none of which need the signer
set. Each package must carry the requested feed, so a package returned under the
wrong key is rejected rather than cached under the wrong feed. Each value must be
positive. The packages combined into one payload must share a timestamp, and that
timestamp must fall within a freshness window, so stale or future gateway
responses are dropped. These are integrity checks layered on top of the on-chain
verification, not a replacement for it.

## Configuration

Configuration is defined via environment variables.
A `.env` file in the working directory is loaded if present.
The `.env.example` contains example values.

- `REDSTONE_GATEWAY_URL` - optional, gateway base URL, defaults to `https://oracle-gateway-1.a.redstone.finance`.
- `REDSTONE_DATA_SERVICE_ID` - optional, data service id, defaults to `redstone-primary-prod`.
- `REDSTONE_FEED_IDS` - required, comma-separated RedStone feed symbols (e.g. `ETH,BTC`).
- `REDSTONE_MIN_SIGNERS` - optional, minimum unique self-verified signers required to cache a feed, defaults to 3.
- `REDSTONE_POLL_INTERVAL_MS` - optional, gateway poll interval in milliseconds, defaults to 1000.
- `INGESTER_TRANSPORT` - optional, `tcp` (default) or `unix`, selects the listener type.
- `INGESTER_SOCKET_ADDRESS` - TCP listen address, defaults to `127.0.0.1:9803` (used when transport is `tcp`).
- `INGESTER_SOCKET_PATH` - Unix socket path, defaults to `/run/relay/redstone.sock` (used when transport is `unix`).
- `INGESTER_HEARTBEAT_SEC` - optional, heartbeat interval in seconds, defaults to 10.
- `INGESTER_WRITE_TIMEOUT_SEC` - optional, per-write timeout in seconds, defaults to 3x the heartbeat interval. A subscriber that stops reading is dropped once a single write exceeds this, freeing the slot.
- `RUST_LOG` - optional, tracing filter, defaults to `info`.

## How to build

Copy the example environment file, fill in the feeds, and run the binary.

```sh
cp .env.example .env # Edit as necessary
cargo build --release --bin redstone-ingester
./target/release/redstone-ingester
```
