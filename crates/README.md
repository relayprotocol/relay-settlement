# Rust crates

The `crates/` Cargo workspace contains standalone oracle ingester services.
Each ingester obtains signed price payloads from one provider, performs the
provider-specific structural and freshness checks that can be done off-chain,
caches the latest valid payload per feed, and streams opaque payloads to the
sequencer over the shared `price-oracle-ipc` TCP protocol. The final trust check
remains in the corresponding on-chain verifier.

| Crate                                        | Purpose                                                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`chainlink-ingester`](./chainlink-ingester) | Streams authenticated Chainlink Data Streams WebSocket reports, validates V3 report structure and freshness, and forwards the original signed report blobs |
| [`pyth-ingester`](./pyth-ingester)           | Streams Pyth accumulator updates from Hermes, verifies their structure and Merkle proofs, and forwards the signed update blobs                             |
| [`redstone-ingester`](./redstone-ingester)   | Polls RedStone data packages, verifies their serialization and recovered signers, assembles canonical multi-signer payloads, and forwards them per feed    |
| [`stork-ingester`](./stork-ingester)         | Streams Stork Fast signed batches, validates taxonomy, feed membership, and freshness, and forwards each batch under its configured feeds                  |

From this directory, common workspace commands are:

```sh
cargo build --workspace
cargo test --workspace
cargo run -p <crate-name>
```

The workspace currently targets Rust 1.93. Each crate's README documents its
provider credentials, feed configuration, network endpoints, and runtime
settings.
