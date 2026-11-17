# Solana VM Relay Router

Anchor program that executes routed depository withdrawals on Solana: a
withdrawal paid to a bundle address, swapped by the executor and delivered to
the recipient in one transaction.

## Program

`relay-router` has two fill instructions that must appear together, top-level,
in the same transaction:

1. `release(bundle_hash, bump, request)` CPIs the depository's
   `execute_transfer_routed`, signing as the router's `depository_caller` PDA,
   so the routed withdrawal lands at the bundle address, and makes the executor
   the delegate of the withdrawn funds (native SOL is wrapped first). The
   allocator's ed25519 instruction must sit directly before `release`.
2. The executor's own swap instructions, paying into the bundle's fill token
   account.
3. `settle(bundle, bump)` pays the whole fill to the recipient and checks what
   it received against `minimum_amount`, returns unspent withdrawn funds to the
   recipient, closes the bundle token accounts (rent to the executor) and sends
   any lamports left at the bundle address to the recipient. Lamports that
   would leave the recipient below the rent-exempt minimum go to the executor
   instead.

For a token withdrawal, `settle` returns the whole balance of the bundle
withdraw account, including tokens anyone else sent to it, when the recipient's
withdraw token account is passed, and closes the account. Without that account
the executor must have spent its whole delegation, or `settle` fails with
`InvalidTokenAccount`; tokens left in the bundle withdraw account then stay
there. An executor that returns unspent input to the bundle withdraw account
must pass the recipient's withdraw token account.

The bundle address is the PDA `["bundle", sha256(borsh(bundle))]`, so every
fill parameter is committed in the address the withdrawal is paid to. The
bundle's `call_accounts` and `calls` are reserved for a later version and must
be empty; `release` rejects any other bundle with `CallsNotSupported`. Only
fills where the withdraw and fill currency differ are routed; `release` rejects
a bundle with the same currency on both sides with `SameCurrencyNotSupported`.

`release` accounts, in order: `executor`, `bundle_address`, `router_authority`,
`depository_program`, `relay_depository`, `vault`, `withdraw_mint`,
`bundle_withdraw_token_account`, `vault_token_account`, `used_request`,
`ix_sysvar`, `withdraw_token_program`, `associated_token_program`,
`system_program`, `depository_role`.

`release_gateway(bundle_hash, bump, request, max_block_height, circle_signature)`
takes the place of `release` for a routed transfer of the gateway depository
(`../gateway-depository-svm`), which mints the transfer from Circle Gateway
into the bundle's token account. It makes the same checks, pairs with `settle`
the same way and counts as the transaction's one release. Gateway transfers
are tokens only. Its accounts, in order: `executor`, `bundle_address`,
`router_authority`, `depository_program`, `relay_gateway_depository`, `vault`,
`withdraw_mint`, `bundle_withdraw_token_account`, `used_request`, `ix_sysvar`,
`gateway_minter_program`, `gateway_minter`, `gateway_minter_custody`,
`used_transfer_spec_hash`, `gateway_minter_event_authority`,
`withdraw_token_program`, `system_program`, `depository_role`.

### Administration

- `initialize(owner)` creates the `["config"]` account. It can run once and
  only with the program's upgrade authority as signer.
- `grant_depository_role(depository)` and `revoke_depository_role(depository)`
  create and close the `["depository_role", depository]` account, signed by
  the config owner. `release` fails with `DepositoryNotAllowed` unless the
  bundle's depository holds the role, so revoking it stops every fill through
  that depository, including requests that are already signed. The role does
  not record which release a depository is for: `release` and
  `release_gateway` reach any depository that holds one, and a request of the
  other kind is rejected by the depository itself (different request layout,
  accounts and signed hash). Before granting a role to a new depository, check
  that its routed request cannot be read as either existing layout.
- `set_owner(new_owner)` hands the config to a new owner, signed by the
  current owner. The handover is one step and cannot be undone, so
  `new_owner` must be a key that can sign; the default pubkey is rejected.

## Program id

`9QybjuydfDYwJkdDLMJJaHEcQPaYeRoiJ5cYj7qLd5Su` in `declare_id!` and
`Anchor.toml` is the development placeholder id. Its keypair is not committed,
so `anchor build` in a fresh checkout generates a different keypair under
`target/deploy` and warns about the mismatch; the build output and tests are
unaffected, but deploying needs the matching keypair.

## Toolchain

This workspace is separate from `../depository-svm`, which stays on Anchor
0.30.1. The pinned toolchain is:

- Anchor CLI 1.2.1 and Solana CLI 4.3.2 (`Anchor.toml` `[toolchain]`)
- Platform tools v1.57
- Rust 1.99.1 for host builds (`rust-toolchain.toml`)

Anchor 1.2.1 builds SBPF v3 by default, which mainnet does not load, so always
build through the package script, which targets v0:

```sh
yarn build # anchor build --arch v0 --tools-version v1.57
```

## Test

The tests load the upgraded depository and its test-only caller program from
`../depository-svm`, and the gateway depository with its Circle Gateway
fixtures from `../gateway-depository-svm`, at fixed program ids (see
`Anchor.toml`), so build those workspaces first:

```sh
(cd ../depository-svm && anchor build && yarn build:fixtures)
(cd ../gateway-depository-svm && yarn install && yarn fetch:fixtures && yarn build)
yarn install
yarn build
yarn build:fixtures
anchor test --skip-build --validator legacy
```

`yarn fetch:fixtures` downloads the Circle Gateway programs and accounts from
Solana mainnet; see the gateway depository README.
