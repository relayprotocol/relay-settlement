# Lit Deposit Address

Lit Action source for deterministic multi-VM wallet derivation and signing.

Supported VM types:

- `ethereum-vm`
- `bitcoin-vm`
- `solana-vm`
- `hyperliquid-vm`
- `ton-vm`
- `tron-vm`

Supported environments: `dev`, `stag`, and `prod`.

Each VM is bundled as its own Lit Action. The shared action runner in `src/vm/action.ts` retrieves a Lit PKP private key **inside the TEE** with `Lit.Actions.getPrivateKey({ pkpId })`, derives deterministic VM wallets from that key, and returns an account-level public derivation root so deposit addresses can also be derived outside the TEE.

## Local commands

```sh
yarn install
yarn test
yarn lint
yarn build
```

## Lit Action bundling and Chipotle setup

The per-VM action sources are generated and bundled per environment with the
`config.ts` placeholders replaced at build time, then registered against a Lit
PKP via Chipotle.

```sh
# Bundle per-VM actions for a specific environment into dist/actions/<env>/<vm>.js
yarn bundle:actions -- --env dev

# Provision Chipotle resources (account, group, action, usage key) for an env
yarn setup -- --env dev --mode api-key --account-api-key <key> --create-pkp
```

Both scripts require an explicit `--env <name>` (`dev`, `stag`, or `prod`);
there is no default.

## Shared Account Helpers

The action-agnostic Lit account helpers run from `../lit-helpers`:

```sh
yarn workspace @relay-protocol/lit-helpers convert-to-chain-secured -- --account-api-key <key> --new-admin-private-key 0x...
yarn workspace @relay-protocol/lit-helpers transfer-ownership -- --account-api-key <key> --current-admin-private-key 0x... --new-admin-address 0x...
yarn workspace @relay-protocol/lit-helpers verify-ownership -- --account-api-key <key> --admin-address 0x...
yarn workspace @relay-protocol/lit-helpers credits -- --account-api-key <account-api-key>
yarn workspace @relay-protocol/lit-helpers top-up -- --account-api-key <account-api-key> --amount-cents 2500
```

`scripts/setup.ts` is idempotent and uses the shared setup backends from
`@relay-protocol/lit-helpers`. PKP selection is explicit: pass `--create-pkp`
to mint a fresh PKP, or `--pkp-id <address>` to reuse one already owned by the
account. Exactly one of the two must be supplied. Pass `--dry-run` to perform
read-only discovery and print which PKPs, groups, actions, and usage keys
already exist, plus which resources would be created, updated, or pruned in a
normal run. The script prints the `LIT_API_KEY`, `LIT_PKP_ID`, and per-VM
`LIT_DEPOSIT_ADDRESSES_ACTION_CID_<VM>` values you'll need to execute the actions.

For accounts owned by an MPC/multisig wallet, pass `--calldata` (ChainSecured
only) instead of `--private-key`: setup runs read-only discovery and prints the
contract calldata for whatever is out of sync as a batch to relay through the
owner, instead of broadcasting. It requires `--pkp-id` and an already-provisioned
usage key. See the [lit-helpers calldata mode docs](../lit-helpers/README.md#calldata-mode-mpc--multisig-owned-accounts).

```sh
yarn setup -- --env dev --mode api-key --account-api-key <key> --create-pkp
yarn setup -- --env dev --mode api-key --account-api-key <key> --pkp-id 0x... --dry-run
yarn setup -- --env dev --mode chain-secured --account-api-key <key> --private-key 0x... --pkp-id 0x...
yarn setup -- --env dev --mode chain-secured --calldata --account-api-key <key> --pkp-id 0x...
```

To mint an additional usage API key for the existing environment group:

```sh
yarn create-usage-api-key -- --env dev --mode api-key \
  --account-api-key <account-api-key> \
  --name deposit-address-dev-usage-key-2 \
  --description "Usage key for Lit Deposit Address"

yarn create-usage-api-key -- --env dev --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-wallet-key> \
  --name deposit-address-dev-usage-key-2 \
  --description "Usage key for Lit Deposit Address"
```

Once the action is bundled and registered, invoke it via the consolidated
`client` CLI (subcommands: `account`, `wallet`, `derive`):

```sh
# Fetch the account-level public root for one VM
yarn client account -- \
  --env dev \
  --usage-api-key <key> \
  --pkp-id <pkp-address> \
  --vm-type ethereum-vm

# Derive the deposit wallet for a set of derivation fields
yarn client wallet -- \
  --env dev \
  --usage-api-key <key> \
  --pkp-id <pkp-address> \
  --input ./derivation-fields.json
```

Both invocations execute the bundled action via Chipotle's `/lit_action`
endpoint using a usage API key authorized for the action CID/group, then print the parsed JSON response. `--input` for `wallet` is a JSON
file whose shape matches `DepositAddressTriggerDerivationFields`; the VM
family of the bundled action loaded for the call is taken from
`derivationFields.inputVmType`.

For production solver integrations, derive deposit wallets locally from the
VM account public root instead of calling the Lit Action's `wallet` action on
every quote or request. The `wallet` action executes inside Lit/Chipotle and
is comparatively expensive; use it for diagnostics and parity checks only.

For offline verification, `derive` reproduces the `wallet` action's output
locally from the `account` action's response plus the same derivation fields.
It uses only public derivation, so it never needs the PKP / TEE:

```sh
yarn client derive -- \
  --account ./account-response.json \
  --input ./derivation-fields.json
```

The `cross-derivation.test.ts` suite asserts that the off-TEE output matches
the in-TEE `wallet` derivation for all VM types.

Solver-facing integration guides for every supported VM live in [`docs/`](./docs/). The docs also describe the end-to-end trust flow: Hub `DepositAddressManager.trigger(...)`, oracle verification/attestation, and the final Lit Action checks before signing.

Every external dependency is imported in `src/` via a full jsDelivr `+esm`
URL, e.g.:

```ts
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { encodeAbiParameters, keccak256 } from "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm";
```

`src/action-env.d.ts` declares each URL as a module that re-exports the types
of the locally installed npm package, so the source still type-checks against
`node_modules`. The bundler marks every `https://` import as external, so the
resulting bundle contains only first-party code; the Lit Action runtime
bundles each URL at execution time via `swc_bundler` and verifies its bytes
against jsDelivr's SRI hash header (with TOFU pinning into the node's
`integrity.lock`). `vitest.config.ts` aliases the same URLs back to local
packages so tests resolve normally.

The Lit docs at
<https://developer.litprotocol.com/lit-actions/imports#full-urls> describe an
inline `#sha384-<hash>` URL fragment for action-source-level SRI assertion.
We are **not** using it currently because the in-production `swc_bundler`
resolves the entry URL with the fragment preserved while pre-fetched sources
are keyed without it, so the bundler reports `bundler requested ... but it
was not pre-fetched` and the action fails to load. Once Lit ships a fix
(`resolve_entry_specifier` should strip the fragment, mirroring
`walk_deps`), re-add the `#sha384-...` fragments here by hashing each URL
with:

```sh
curl -sSL '<full-jsdelivr-url>' | openssl dgst -sha384 -binary | base64 -w0
```

Integrity of the action's import URLs is still anchored on-chain via the
IPFS CID registered on the Chipotle action registry, since that CID is
computed over the bundled file's exact byte content (including the URL
specifiers).

Because the source files import from URLs, this package is primarily action source and test/dev tooling. Production integrators should consume the canonical bundled action code and environment config from the sibling `../lit-actions` package. Local development can still use the generated per-VM action files under `dist/actions/<env>/<vm>.js`.

## Quick local derivation example

The local derivation helpers still accept an explicit `rootKeyHex`. This is for tests/dev tooling and mirrors what the Lit Action does after it retrieves the PKP private key inside the TEE.

```sh
npx tsx -e '
import {
  deriveAccount,
  deriveWallet,
  deriveWalletFromExtendedPublicKey,
} from "./src/derivation/index.ts";

const rootKeyHex = "0x" + "11".repeat(32);
const vmType = "ethereum-vm";
const indexes = [0];

const account = await deriveAccount(rootKeyHex, vmType);
console.log("account", account);

const wallet = await deriveWallet(rootKeyHex, vmType, indexes);
console.log("wallet", wallet);

const publicOnly = await deriveWalletFromExtendedPublicKey(
  vmType,
  account.extendedPublicKey,
  indexes,
);
console.log("wallet from public root", publicOnly);

'
```

Change `vmType` to `bitcoin-vm`, `solana-vm`, `hyperliquid-vm`, or `ton-vm` to test other implementations. `indexes` is a non-empty array of unhardened uint31 child segments appended to the account path; in production the `wallet` and `sign` actions derive it from `derivationFields` (see below).

## Lit Action API

The shared action runner in `src/vm/action.ts` dispatches on a `jsParams.action` of `"account"`, `"wallet"`, or `"sign"`. Each VM bundle pins itself to one VM family and rejects mismatched inputs.

The full request/response shapes, the `requestSignature` requirement, the per-VM transaction policy, and the end-to-end design live in [`docs/`](./docs/). Solver integrators should start there.

## Environment config

Each environment has its own config file under `environments/` (one JSON file per
environment, e.g. `environments/dev.json`). Every file follows the same shape:

```json
{
  "name": "<env>",
  "depositAddressManagerAddress": "0x...",
  "hubEvmChainId": 0,
  "allowedOracles": ["0x..."],
  "oracleSignatureThreshold": 1
}
```

The Lit Action-facing constants are exposed from `src/config.ts` and are intended to be replaced at bundle time, following the same pattern as `../lit-allocator`:

```ts
export const ACTION_ENV = __ACTION_ENV__;
export const DEPOSIT_ADDRESS_MANAGER_ADDRESS = __DEPOSIT_ADDRESS_MANAGER_ADDRESS__;
export const HUB_EVM_CHAIN_ID = Number.parseInt(__HUB_EVM_CHAIN_ID__, 10);
export const ALLOWED_ORACLES = JSON.parse(__ALLOWED_ORACLES__) as string[];
export const ORACLE_SIGNATURE_THRESHOLD = Number.parseInt(__ORACLE_SIGNATURE_THRESHOLD__, 10);
```

## Architecture

Only `action-env.d.ts` and `config.ts` live at `src/` root; action entrypoints are generated by `scripts/bundle-actions.ts`, and the shared action runner lives under `src/vm/action.ts`. Everything else is organized into subdirectories:

```txt
src/
  action-env.d.ts                 # Lit globals
  config.ts                       # bundle-time env constants
  vm/
    action.ts                     # shared account / wallet / sign dispatcher
  attestation/
    index.ts                      # verifyDepositAddressTriggerAttestation
  common/
    bytes.ts
    crypto.ts
    types.ts
    vm.ts                         # isVmType / assertVmType
  derivation/
    index.ts                      # public API (deriveAccount, deriveWallet, ...)
    path.ts                       # derivationFieldsToIndexes
    vm/
      base/
        VmWalletDeriver.ts             # abstract base / shared orchestration
        Secp256k1VmWalletDeriver.ts    # shared secp256k1 account derivation
        Ed25519Bip32VmWalletDeriver.ts # shared CIP-3 / BIP32-Ed25519 derivation
      ethereum/EthereumVmWalletDeriver.ts       # ethereum-vm implementation
      bitcoin/BitcoinVmWalletDeriver.ts         # bitcoin-vm implementation
      solana/SolanaVmWalletDeriver.ts           # solana-vm implementation
      hyperliquid/HyperliquidVmWalletDeriver.ts # hyperliquid-vm implementation
      ton/TonVmWalletDeriver.ts                 # ton-vm implementation
```

`src/derivation/index.ts` is the package's public entrypoint — it re-exports the types from `common/types.ts`, the `derivationFieldsToIndexes` helper, and the derivation/signing API.

## Key derivation

For each VM, the package first derives VM-specific seed material:

- `HKDF-SHA256`
- salt: `"lit-deposit-addresses"`
- info: VM type (`ethereum-vm`, `bitcoin-vm`, `solana-vm`, `hyperliquid-vm`, `ton-vm`)
- input key material: the PKP private key inside Lit, or explicit `rootKeyHex` in local helpers

It then uses `@metamask/key-tree` for HD derivation:

- `ethereum-vm`: secp256k1 BIP32
- `bitcoin-vm`: secp256k1 BIP32
- `solana-vm`: `ed25519Bip32` / CIP-3-style derivation
- `hyperliquid-vm`: secp256k1 BIP32
- `ton-vm`: `ed25519Bip32` / CIP-3-style derivation (Wallet V5R1 deposit wallets)

### Paths

The full path is the VM's account path followed by every entry in `indexes`:

- `ethereum-vm`: account path `m/44'/60'/0'/0`, child path `.../<i0>/<i1>/.../<iN>`
- `bitcoin-vm`: account path `m/84'/0'/0'/0`, child path `.../<i0>/<i1>/.../<iN>`, native segwit `bc1...` addresses
- `solana-vm`: account path `m/44'/501'/0'/0`, child path `.../<i0>/<i1>/.../<iN>`
- `hyperliquid-vm`: account path `m/44'/60'/0'/0`, child path `.../<i0>/<i1>/.../<iN>`, EVM-style `0x...` addresses
- `ton-vm`: account path `m/44'/607'/0'/0`, child path `.../<i0>/<i1>/.../<iN>`, Wallet V5R1 StateInit `0:...` addresses

For `wallet` and `sign`, the eight-segment `indexes` array is computed as `keccak256(abi.encode(derivationFields))` split into eight 32-bit words with the top bit of each cleared. `derivationFields.salt` is a caller-generated random uint256 (represented as a decimal string in JSON); generate a fresh salt for each new deposit address.

## Important Solana note

Standard Solana wallets normally use hardened-only SLIP-0010-style derivation, which is **not** publicly derivable.

This package intentionally uses `@metamask/key-tree`'s public-derivable `ed25519Bip32` / CIP-3-style scheme for `solana-vm` so deposit addresses can be derived from the returned public account root.

That means the `solana-vm` path here is **non-standard for most Solana wallets**, but it still produces valid Ed25519 keypairs and valid Solana addresses.

## Source API

The same derivation/signing helpers the action uses are also exposed by
`src/derivation/index.ts` for use by tests and dev tooling:

```ts
import {
  deriveAccount,
  deriveWallet,
  deriveWalletFromExtendedPublicKey,
  derivationFieldsToIndexes,
  signTransactionsWithWallet,
  verifyTransactionsWithWallet,
  getSupportedVmTypes,
} from "./src/derivation/index.js";
```

### `deriveAccount(rootKeyHex, vmType)`

Derives the account-level public root.

For secp256k1 VMs, `extendedPublicKey` is a standard BIP32 xpub.

For the Ed25519 VMs (`solana-vm`, `ton-vm`), `extendedPublicKey` is a JSON-serialized neutered `SLIP10Node` from `@metamask/key-tree`, including public key, chain code, curve, and metadata needed for public child derivation.

### `deriveWallet(rootKeyHex, vmType, indexes)`

Derives a child wallet at the given derivation path using the private root key.
`indexes` is a non-empty array of unhardened uint31 child indexes appended to
the account path.

### `deriveWalletFromExtendedPublicKey(vmType, extendedPublicKey, indexes)`

Derives the same child wallet from the account public root only.

For the same root key, `vmType`, and `indexes`, these produce the same address:

```ts
const account = await deriveAccount(rootKeyHex, vmType);

const privateDerived = await deriveWallet(rootKeyHex, vmType, indexes);
const publicDerived = await deriveWalletFromExtendedPublicKey(
  vmType,
  account.extendedPublicKey,
  indexes,
);

privateDerived.address === publicDerived.address; // true
```

### `derivationFieldsToIndexes(derivationFields)`

Maps a `DepositAddressTriggerDerivationFields` value to the deterministic
eight-segment unhardened path used by both the `wallet` and `sign` actions.

### `verifyTransactionsWithWallet(trigger, attestation, transactions)`

Runs the same VM-specific deposit policy checks that the Lit Action runs before signing. This helper is intended for tests and preflight checks; successful local verification is not a substitute for the in-TEE check performed by `action: "sign"`.

### `signTransactionsWithWallet(rootKeyHex, vmType, indexes, transactions)`

Signs one or more VM-native transactions with the child wallet at `indexes`,
deriving the private key only once. The transaction and signed-transaction
shapes are documented in the [`sign` action section](#sign).

## Testing

Tests live in `tests/`.

```sh
yarn test
```

Current coverage includes:

- public derivation matches private derivation for all VM types
- account root stability across runs
- different `indexes` and root keys produce different wallets
- multi-index derivation paths
- VM-specific wallet formatting (Ethereum / Bitcoin / Solana / Hyperliquid)
- transaction signing for all VMs (Ethereum: parse-and-recover, Bitcoin: per-input ECDSA verification, Solana: Ed25519 verification + signed-transaction layout, Hyperliquid: EIP-712 nonce mapping and sendAsset signing)
- trigger attestation signature verification
- derivation-fields-to-indexes determinism and sensitivity
- invalid index / empty input rejection
