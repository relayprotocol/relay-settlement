# Rust crates

Rust workspace for the price oracle EVM precompile and its runtime adapters.

## Layout

- `price-oracle-precompile/` — Runtime-agnostic core. Implements
  `getUsdPrice(uint256)` ABI dispatch over hardcoded ETH/BTC/USDC prices,
  with no dependency on revm/reth. This is the crate that gets reused
  across reth, the Sovereign SDK rollup, and any test harness.
- `oracle-reth/` — Placeholder for the reth/revm adapter. Today it only
  pins the mount address and documents the intended `revm-precompile`
  wiring; real registration lands once we pin a revm version.
- `oracle-rpc-demo/` — End-to-end demo. Boots a real revm EVM with the
  precompile registered at `0x...FEED`. Two modes:

  ```sh
  # one-shot: dispatch getUsdPrice(ETH) locally and print the trace
  cargo run -p oracle-rpc-demo -- --once
  # → decoded: 350000000000  (USD scaled by 1e8)
  # → human:   $3500.00

  # server: listen on 127.0.0.1:8547 and route eth_call into revm
  cargo run -p oracle-rpc-demo
  ```

  From another shell, hit the server with curl:

  ```sh
  curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_call",
      "params":[{"to":"0x000000000000000000000000000000000000FEED",
                 "data":"0x2695b3a20000000000000000000000000000000000000000000000000000000000000001"},"latest"]}' \
    http://127.0.0.1:8547
  # → {"jsonrpc":"2.0","id":1,"result":"0x...517da02c00"}  (350000000000, i.e. $3500)
  ```

## Common commands

Run from this directory (`crates/`):

```sh
cargo build           # build all crates
cargo test            # run unit + integration tests
cargo fmt --all       # format
cargo clippy --all-targets --all-features -- -D warnings
```

From the repo root, pass `--manifest-path crates/Cargo.toml` or just `cd crates`.

## Adding a token

Edit `price-oracle-precompile/src/prices.rs`:

1. Add a `TOKEN_ID_*` constant.
2. Add a match arm in `price_for`.
3. Add a test in `precompile.rs` mirroring the existing ones.

Once we wire in a real feed (Redstone / Chainlink), the hardcoded table
goes away — but the public surface (`getUsdPrice` + token ids) is meant
to stay stable.
