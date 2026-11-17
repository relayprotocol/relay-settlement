# Solana VM Relay Gateway Depository

Anchor program that connects Relay to Circle Gateway on Solana, the
counterpart of the EVM `RelayGatewayDepository`:

- `execute_transfer` pays an allocator-signed transfer out of a Circle Gateway
  mint. The allocator's ed25519 signature over the request sits in the
  instruction right before it. The program mints the request's transfer spec
  from Circle into its vault and forwards the amount to the recipient's
  associated token account in the same instruction.
- `execute_transfer_routed` does the same for a routed request, and
  additionally requires the signature of the router program named in the
  request, so it only executes inside that router's instruction (see
  `../router-svm`).
- `deposit` moves USDC from the sender into the allocator's Circle Gateway
  balance. Deposits are disabled until the owner enables them.

The vault is a token account at the `["gateway_vault"]` address, owned by the
`["relay_gateway_depository"]` state account. That one address is both the
destination caller and the destination recipient of the Circle transfers the
program executes. A `["used_request", request hash]` account marks every
executed request.

## Configuration

- `initialize(chain_id, owner)` creates the state and the vault, and sets the
  allocator, the USDC mint and the Circle GatewayMinter and GatewayWallet
  programs. It can run once and only with the program's upgrade authority as
  signer. The mint and the Circle programs cannot be changed afterwards.
- `set_owner`, `set_allocator` and `set_deposits_enabled` are signed by the
  owner. The owner handover is one step and cannot be undone, so `new_owner`
  must be a key that can sign; the default pubkey is rejected for both the
  owner and the allocator. Circle Gateway funds deposited under a previous
  allocator stay with that allocator.
- `sweep` lets the owner move out tokens that were sent to the vault directly.

## Program id

`DAt1pZmsCkKJ3WETGZPrtLhZq9inV3DrBSeZu12EKSe8` in `declare_id!` and
`Anchor.toml` is the development placeholder id. Its keypair is not committed,
so `anchor build` in a fresh checkout generates a different keypair under
`target/deploy` and warns about the mismatch. The build output and the tests are
unaffected, but deploying needs the matching keypair. The program is not
deployed on mainnet yet.

## Toolchain

Same as `../router-svm`, and separate from `../depository-svm`, which stays on
Anchor 0.30.1:

- Anchor CLI 1.2.1 and Solana CLI 4.3.2 (`Anchor.toml` `[toolchain]`)
- Platform tools v1.57
- Rust 1.99.1 for host builds (`rust-toolchain.toml`)

Anchor 1.2.1 builds SBPF v3 by default, which mainnet does not load, so always
build through the package script, which targets v0:

```sh
yarn build # anchor build --arch v0 --tools-version v1.57
```

## Test

The tests run against the Circle Gateway programs and a test-only router
stand-in from `../depository-svm` (see `Anchor.toml`):

```sh
(cd ../depository-svm && yarn build:fixtures)
yarn install
yarn fetch:fixtures
yarn build
anchor test --skip-build --validator legacy
```

`yarn fetch:fixtures` downloads the Circle Gateway programs and accounts from
Solana mainnet into `tests/fixtures/circle-gateway` (set `SOLANA_RPC_URL` to
use another RPC). The minter's attester and the USDC mint authority are
replaced with the test keys in `constants.ts`, so the tests can sign Circle
attestations and mint USDC. The downloaded files are not committed.

`cargo test` checks the request hashes against the vectors shared with the Hub
payload builder and the SDK.

## Property tests

`fuzz/` runs generated transfers and deposits against the compiled program on
LiteSVM and checks where the funds ended up; see its README.

## Layout

```text
gateway-depository-svm/
├── Anchor.toml
├── Cargo.toml
├── fuzz/
├── programs/
│   └── relay-gateway-depository/
└── tests/
    ├── fixtures/
    │   └── circle-gateway/
    └── relay-gateway-depository.ts
```
