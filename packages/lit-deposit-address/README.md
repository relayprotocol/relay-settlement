# Lit Deposit Address

Lit Actions that derive per-order deposit wallets and sign the transactions
that sweep those wallets into Relay depositories. This is a separate protocol
component from [`lit-allocator`](../lit-allocator): deposit-address actions
handle funds entering the protocol, while allocator actions sign withdrawals
on destination chains.

The actions are not general-purpose wallet signers. A sweep is signed only when
it matches a Hub `DepositAddressManager` trigger, a valid oracle attestation, a
signed Relay order, the solver's explicit request signature, and the VM-specific
transaction policy.

## Protocol flow

1. The solver constructs a Relay order and its `derivationFields`.
2. The deposit wallet is derived deterministically from the VM account public
   root and those fields. This derivation happens locally during normal quote
   and order handling; it does not require a Lit call.
3. The user funds the derived wallet.
4. The solver submits the matching trigger to the Hub
   `DepositAddressManager`.
5. The Relay oracle verifies the on-chain trigger and returns a signed
   attestation.
6. The solver builds the VM-native sweep transaction and signs the complete Lit
   request with the `order.solver` EOA.
7. Inside Lit's TEE, the action verifies the request, derives the deposit
   wallet's private key, and signs the sweep.
8. The solver broadcasts the signed transaction to the input chain.

The PKP private key and deposit-wallet private keys never leave the TEE. The
deposit-address manager, Hub chain id, oracle allowlist, and signature threshold
are compiled into each environment bundle and cannot be overridden by the
caller.

## Supported bundles

The active environments are `dev`, `stag`, and `prod`. Each environment has a
separate bundle for:

- `ethereum-vm`
- `bitcoin-vm`
- `solana-vm`
- `hyperliquid-vm`
- `ton-vm`
- `tron-vm`
- `xrp-vm` (native XRP Payment sweeps)

### XRP Payment sweeps

The XRP source supports public derivation through `account` and `wallet`. The
`sign` operation accepts one serialized unsigned native `Payment` in
`unsignedTransaction` (hex without `0x`). It returns `rawTransaction` and the
uppercase XRPL `transactionHash`.

The input protocol chain id must be `xrp` (XRPL Mainnet). Mainnet Payments
omit `NetworkID`; Relay's numeric chain row is a separate identifier.
The policy binds `Account` to the derived wallet, `Destination` to the attested
depository, and `Amount` to the full trigger input. Fund the wallet with enough
additional XRP for its fee and the ledger-required account reserve. The
[funding steps](./docs/README.md#3-fund-the-wallet) describe the balance check.

Exactly one `MemoData` contains UTF-8
`<orderId>|depositor=<classic XRP address>|`. Its depositor AccountID must equal
`trigger.derivationFields.depositor`. The companion Oracle must parse this
format to preserve the original depositor for recovery.

Before recording the Hub trigger, encode a validated ledger reference in
`trigger.extraData` as ABI `(uint32 ledgerIndex, uint64 observedAt)`, where
`observedAt` is Unix time in seconds. Oracle checks the index against its
configured XRP RPC and accepts references at most four validated ledgers behind.
At attestation, Oracle requires a reference at most 15 seconds old and rejects
future timestamps.

Lit calculates the ledger window from the attested `observedAt` so every node
uses the same time. `LastLedgerSequence` must exceed the reference index by at
most 32 (about 2 minutes). When a price expires
within 320 seconds of `observedAt`, the window allows 10 seconds per ledger
between `observedAt` and the earliest price expiry. Shared checks still reject
expired prices and require over one hour before settlement and refund deadlines.

For XRP, construct the trigger data with the validated ledger index:

```ts
import { encodeAbiParameters } from "viem";

const extraData = encodeAbiParameters(
  [{ type: "uint32" }, { type: "uint64" }],
  [validatedLedgerIndex, BigInt(Math.floor(Date.now() / 1000))],
);
```

Select a pricing oracle that resolves every requested currency without decoding
`extraData`, such as `RelayPriceOracle` with configured feeds. Its returned prices
belong in `trigger.prices`. The example helper `encodePricesExtraData` encodes a
different payload for `BasicPricingOracle`. XRP's ledger payload is incompatible
with that oracle and with the signed-price fallback in `SignedPricingOracle`.

The 15-second budget includes Hub inclusion and Oracle attestation. If Oracle
rejects an expired reference, record a new trigger for the same order with a
fresh reference and a new nonce, then obtain its attestation and sign a new
request. The derivation fields stay the same, preserving the funded wallet.
Measure this complete flow in dev before relying on XRP sweeps.

Fees must be from 1 through 10,000 drops. `Sequence` must be a positive uint32.
Only `tfFullyCanonicalSig` may be set in `Flags`. Tags and issued assets are
outside this step. Ledger expiry measures ledger progress, so a ledger halt can
extend its wall-clock lifetime. Submission must recheck order validity.

Bundle generation and package exports include XRP `v1.2` in dev, stag, and prod.
Packaged `v1.2` allows the 32-ledger window above; the CIDs registered in stag
and prod allow at most 4 ledgers until their rebuilt `v1.2` is registered.
Setup registration currently includes XRP only in dev. The action signs sweeps
that pass the policy above. Deploy and verify the
companion Oracle changes for memo attribution and ledger-reference validation
before registering the dev XRP action. Reserve and fee funding, recovery of
retained XRP, and refund signing require separate implementation.

The exact code released to integrators is packaged by
[`@relay-protocol/lit-actions`](../lit-actions).

## Action API

Each VM bundle accepts one of three operations:

| `action`  | Purpose                                                                                | Who should use it                                 |
| --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `account` | Returns the VM account public root derived from the PKP.                               | Integrators provisioning local public derivation. |
| `wallet`  | Derives one deposit wallet from `derivationFields` inside the TEE.                     | Diagnostics and parity checks.                    |
| `sign`    | Verifies the complete deposit flow and signs one or more VM-native sweep transactions. | The production solver flow.                       |

Every call requires a usage API key authorized for the action and PKP group.
`sign` additionally requires `requestSignature`, an EIP-191 signature from
`order.solver` over the canonical sign request. A usage API key alone cannot
authorize a sweep.

Before signing, the action verifies:

1. the bundle VM matches the trigger and derivation fields;
2. the request signature belongs to `order.solver`;
3. the attestation has enough signatures from the configured oracle set;
4. the attestation references the configured Hub chain and
   `DepositAddressManager`;
5. the supplied trigger hashes to the attested trigger hash;
6. the order and order signature match the trigger; and
7. every VM-native transaction satisfies the deposit policy for that VM.

The output and every refund must have deadlines more than one hour after the
current Unix time in seconds when signing, allowing time for broadcast and
confirmation. Every refund deadline must also be at or after the output deadline
so the refund window covers the fill window. Every refund minimum must cover at least
`input.amount * (10000 - priceImpactBps) / 10000`, rounded up to the next raw
token unit. Refunds use the input currency and the same `priceImpactBps` tolerance
as the output's USD-value check.

The price-impact check requires `usdPriceDecimals` and `currencyDecimals` for
both input and output prices to be JSON numbers that are integers from 0 to 255.
Numeric strings such as `"18"` are rejected even though they produce the same
ABI trigger hash as `18`; callers must preserve numeric types when passing
prices to the action.

The exact request and response types, trigger fields, transaction policies, and
end-to-end solver recipe are in the [solver integration guide](./docs). Start
there when implementing a production integration.

## Public deposit-address derivation

Call `account` once for each VM and store its public account root. Production
services should derive deposit wallets locally from that public root rather
than call Lit for every quote. No private key is needed for public child
derivation.

The `derivationFields` tuple is hashed and split into eight unhardened child
indexes. Every field, including the random `salt`, affects the resulting
address. The solver, Hub trigger, oracle, and action must therefore use exactly
the same encoded fields. Generate a fresh cryptographically random salt for
every new deposit address.

The Solana and TON implementations use a publicly derivable BIP32-Ed25519
scheme. In particular, the Solana derivation is intentionally different from
the hardened-only derivation used by most consumer Solana wallets.

## Build and bundle

Run from the repository root:

```sh
yarn workspace @relay-protocol/lit-deposit-address build
yarn workspace @relay-protocol/lit-deposit-address bundle:actions -- --env dev
```

`bundle:actions` writes one environment-specific file per VM to
`dist/actions/dev/<vmType>.js`. Production consumers should use the canonical
bundles from [`@relay-protocol/lit-actions`](../lit-actions), not copy these
local build artifacts.

External runtime dependencies use versioned jsDelivr `+esm` URLs. Changing one
of those URLs changes the final action code and CID just like changing local
source.

## Register an environment with Lit

The package-specific setup command registers the deposit-address bundles, PKP,
group, and usage API key:

```sh
# Managed Lit account
yarn workspace @relay-protocol/lit-deposit-address setup -- \
  --env dev --mode api-key \
  --account-api-key <account-api-key> \
  --create-pkp

# Wallet-owned ChainSecured account using an existing PKP
yarn workspace @relay-protocol/lit-deposit-address setup -- \
  --env dev --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-key> \
  --pkp-id 0x<pkp-address>
```

The command manages the `deposit-address-<env>` group and
`deposit-address-<env>-usage-key`, registers every per-VM action, preserves older
action registrations and group permissions, and prints `LIT_API_KEY`, `LIT_PKP_ID`, and the
per-VM action CIDs. Pass `--dry-run` to inspect the changes first.

Disabling XRP signing in dev requires each attached hash to match a freshly built
target or a named action in the account or group listing. Setup stops before
changing group permissions when a hash has no match. Review the reported hashes
and name or revoke those actions before retrying.

Pass `--prune-old-versions` to explicitly remove older versions of this
environment's canonical per-VM actions from the group and account. Replacements
are registered and attached before pruning; in `--calldata` mode, additions
precede removals in the emitted batch. Unrelated actions are preserved.

Only prune after verifying the replacement actions and completing migration or
sweeping all wallets that depend on the old derivation. A derivation change can
make legacy wallets unsignable with the new action. Keep the existing PKP and
legacy action CIDs available until those wallets no longer need signing. Use
`--dry-run --prune-old-versions` to preview cleanup.

Account modes, PKP creation, ownership, billing, usage-key rotation, and
MPC/multisig `--calldata` mode are documented once in
[`lit-helpers`](../lit-helpers#action-package-setup).

To create another usage key for this environment's group:

```sh
yarn workspace @relay-protocol/lit-deposit-address create-usage-api-key -- \
  --env dev --mode api-key \
  --account-api-key <account-api-key> \
  --name deposit-address-dev-usage-key-2 \
  --description "Usage key for Lit Deposit Address"
```

## Verify public derivation locally

The client CLI can fetch an account root, derive a wallet inside Lit, and
derive the same wallet locally:

```sh
# Fetch the public account root once
yarn workspace @relay-protocol/lit-deposit-address client account -- \
  --env dev \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --vm-type ethereum-vm > account.json

# Derive in Lit for a parity check
yarn workspace @relay-protocol/lit-deposit-address client wallet -- \
  --env dev \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --input derivation-fields.json

# Derive locally from public data only
yarn workspace @relay-protocol/lit-deposit-address client derive -- \
  --account account.json \
  --input derivation-fields.json
```

The `wallet` and `derive` results should contain the same address. Full signing
examples for every VM live under [`scripts/examples/`](./scripts/examples) and
are linked from the [solver integration guide](./docs#runnable-examples).

## Environment configuration

Each file in `environments/` defines the values embedded in that environment's
bundles:

```json
{
  "name": "dev",
  "depositAddressManagerAddress": "0x...",
  "hubEvmChainId": 0,
  "allowedOracles": ["0x...", "0x..."],
  "oracleSignatureThreshold": 2
}
```

## Development

```sh
yarn workspace @relay-protocol/lit-deposit-address test
yarn workspace @relay-protocol/lit-deposit-address lint
yarn workspace @relay-protocol/lit-deposit-address format:check
```

Tests cover public/private derivation parity, wallet formats, transaction
policies and signatures, order binding, trigger attestations, and invalid
inputs without requiring a live Lit connection.

## Deployment rule

Lit Action code is content-addressed and immutable by CID. Any source,
dependency, or environment-configuration change requires rebundling,
registering the new CIDs for every affected environment and VM, updating
`@relay-protocol/lit-actions`, and completing downstream integration testing.
Follow the shared [deployment checklist](../lit-actions/DEPLOYMENT.md).
