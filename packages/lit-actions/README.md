# Lit Actions in Relay

Relay currently uses Lit Actions for two separate protocol components:

| Component                                       | Purpose                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`lit-allocator`](../lit-allocator)             | Derives protocol-controlled wallets and signs allocator withdrawals after verifying the oracle attestation and the hashes produced by the Hub allocator flow.                                             |
| [`lit-deposit-address`](../lit-deposit-address) | Derives per-order deposit wallets and signs transactions that move funds from those wallets into the protocol after verifying the Hub deposit trigger, oracle attestation, order, and transaction policy. |

These components have different source code, policies, environment
configuration, Lit registrations, and integration flows. A change to one does
not automatically update the other.

The [`@relay-protocol/lit-actions`](.) package is **not another Lit Action**. It
is the release package that bundles the latest active versions of both
components for their supported environments and VM types. Protocol services
should consume action code and configuration from this package instead of
copying bundles from the source packages.

## How they are used

For both components, the basic flow is:

1. A caller selects the component, protocol environment, version, and VM type.
2. `@relay-protocol/lit-actions` returns the corresponding bundled JavaScript
   code and its environment configuration.
3. The caller sends the code, request parameters, PKP id, and usage API key to
   Lit Protocol.
4. The action runs inside Lit's TEE, retrieves the PKP private key, validates
   the component-specific request and oracle attestation, and signs only if all
   checks pass.
5. The caller submits the signed transaction or payload to the destination
   chain.

The PKP private key and derived private keys do not leave the TEE. Contract
addresses, Hub chain id, allowed oracles, and signature threshold are compiled
into each environment-specific bundle and cannot be supplied by the caller.

## Packaged environments

The current package exposes the following matrix:

| Component       | Environments          | Versions     | VM types                                                                                |
| --------------- | --------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Allocator       | `dev`, `stag`, `prod` | `v1`, `v2`   | Bitcoin, Ethereum, Gateway, Hedera, Hyperliquid, Lighter, Solana, TON, Tron, XRP        |
| Allocator       | `dev`, `stag`, `prod` | `v3`         | Atlas, Bitcoin, Ethereum, Gateway, Hedera, Hyperliquid, Lighter, Solana, TON, Tron, XRP |
| Allocator       | `test`                | `v1`, `v2`   | Ethereum (`v1`), Atlas (`v2`)                                                           |
| Allocator       | `test`                | `v3`         | Atlas, Bitcoin, Ethereum, Gateway, Hedera, Hyperliquid, Lighter, Solana, TON, Tron, XRP |
| Deposit address | `dev`, `stag`, `prod` | `v1`, `v1.1` | Bitcoin, Ethereum, Hyperliquid, Solana, TON, Tron                                       |
| Deposit address | `dev`, `stag`, `prod` | `v1.2`       | Bitcoin, Ethereum, Hyperliquid, Solana, TON, Tron, XRP                                  |

Each component and environment produces different action code because its
configuration is embedded at build time.

A version is either **built** from the source package on every generation, or
**frozen**: copied verbatim from an exact published version of this package so
its CIDs never move. Allocator `v1` and `v2` are frozen from `0.0.41` in every
environment (`v1` as first published in `0.0.32` plus the `gateway-vm` bundle it
shares with `v2`; `v2` adds multi-gateway Lighter support, `lighterGateways`). They
sign for the allocator each environment ran before the Hub-chain core redeploy
(DEC-1891). Test `v2` is the exception: its atlas-vm `v2` signs the Oct 29
Atlas format for test's pre-redeploy allocator and is frozen from `0.0.43`,
since atlas-testnet stays on that allocator. Allocator `v3` is frozen from
`0.0.42` for `dev` and signs for dev's redeployed allocator; test `v3` is frozen
from `0.0.47` and signs for test's redeployed allocator, except its atlas-vm
action, which is built from source: it signs Atlas's Nov 9 gapless format and
adds `onboard`, and the version's config takes its `atlasDomain` from that
build. Stag
`v3` is frozen from `0.0.48` and signs for stag's redeployed allocator. Prod
`v3` is built from source and signs for prod's redeployed allocator. Callers
pick `v2` or `v3` by the allocator a withdrawal was submitted to. Deposit-address
`v1` actions are frozen from `0.0.36`; deposit-address `v1.1` is frozen from `0.0.39`:
it lets a Bitcoin sweep pay change back to the deposit address and adds the refund,
deadline, price-decimal and sweep-metadata checks merged since `0.0.36` (#845, #872,
#875) on every VM. Deposit-address `v1.2` lets a Solana sweep carry a capped priority fee (ComputeBudget
instructions before the deposit) and packages XRP derivation and native Payment
sweep signing for dev, stag, and prod (#971); XRP is absent from the frozen `v1`
and `v1.1` versions. Since `0.0.44` it widens the XRP sweep ledger window from
4 to 32 ledgers (#989). Since `0.0.45`, only its XRP bundle is built from
current source in each environment; every other VM is frozen from `0.0.44`.
Every VM accepts `priceImpactBps` of 10000: `0.0.45` shipped an XRP bundle
that rejected it (#972, reverted in #1013), and `0.0.46` restores the XRP
bundle published in `0.0.44`.

Each environment must have the `0.0.46` XRP `v1.2` CID registered before its
callers adopt the release; the `0.0.45` XRP CIDs must not be used. Which
entries are frozen is declared in the `KINDS` matrix in
`scripts/generate-actions.ts`; generation fails if a frozen version cannot be
fetched.

## Important: every code change requires redeployment

**Treat every Lit Action code change, however small, as a full deployment and
integration change.**

Follow the concrete [deployment checklist](./DEPLOYMENT.md) for every affected
environment.

Lit Action registrations are content-addressed. Changing action source,
bundled dependencies, imported dependency versions, or embedded environment
configuration changes the final bundle and therefore its CID. Existing
registrations and integrations continue to point at the old code.

For every affected component, environment, and VM type, a change requires:

1. building the new action bundle;
2. registering/deploying the new bundle with Lit;
3. updating `@relay-protocol/lit-actions` to package the active bundle and
   configuration;
4. publishing and adopting the new package version in every caller;
5. updating any configured action CIDs or related integration values; and
6. running the complete end-to-end integration flow before switching traffic.

Do not assume that a source-only change is live after merging or publishing
this repository. The new action must be deployed and every consumer must be
integrated with it.

## Package API

```ts
getAllocatorAction(environment, version, vmType)
getDepositAddressAction(environment, version, vmType)
```

Each helper returns:

- `code`: the exact bundled JavaScript source to execute;
- `config`: the environment configuration compiled into that bundle.

Example:

```ts
import { getAllocatorAction } from "@relay-protocol/lit-actions"
import { VmType } from "@relay-protocol/settlement-sdk"

const vmType: VmType = "ethereum-vm"
const action = getAllocatorAction("dev", "v2", vmType)

console.log(action.code)
console.log(action.config)
```

The helpers throw if the requested component, environment, version, or VM type
is not packaged.

## Updating this package

The action source remains in `lit-allocator` and `lit-deposit-address`. During
generation, this package runs their bundlers, reads the generated per-VM code
and environment configuration, and writes `src/generated.ts`.

```sh
yarn workspace @relay-protocol/lit-actions generate
yarn workspace @relay-protocol/lit-actions build
```

`src/generated.ts` is generated and must not be edited manually. To change the
packaged environments, versions, or VM types, update the `KINDS` matrix in
`scripts/generate-actions.ts`.

`yarn workspace @relay-protocol/lit-actions lint` type-checks the generation
scripts under `scripts/` against `tsconfig.scripts.json`.
