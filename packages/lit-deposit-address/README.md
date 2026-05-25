# lit-deposit-addresses

Lit Action source for deterministic multi-VM wallet derivation and signing.

Supported VM types:

- `ethereum-vm`
- `bitcoin-vm`
- `solana-vm`

The Lit Action in `src/action.ts` retrieves a Lit PKP private key **inside the TEE** with `Lit.Actions.getPrivateKey({ pkpId })`, derives deterministic VM wallets from that key, and returns an account-level public derivation root so deposit addresses can also be derived outside the TEE.

## Local commands

```sh
yarn install
yarn test
yarn lint
yarn build
```

## Lit Action bundling and Chipotle setup

The action source in `src/action.ts` is bundled per environment with the
`config.ts` placeholders replaced at build time, then registered against a Lit
PKP via Chipotle.

```sh
# Bundle the action for a specific environment into dist/actions/<env>/action.js
yarn bundle:actions -- --env dev

# Provision Chipotle resources (account, group, action, usage key) for an env
yarn setup -- --env dev --account-api-key <key>
```

Both scripts require an explicit `--env <name>` matching one of the
`environments/*.json` files; there is no default.

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
account. Exactly one of the two must be supplied. The script prints the
`LIT_API_KEY`, `LIT_PKP_ID`, and
`LIT_DEPOSIT_ADDRESSES_ACTION_CID` you'll need to execute the action.

```sh
yarn setup -- --env dev --account-api-key <key> --create-pkp
yarn setup -- --env dev --account-api-key <key> --pkp-id 0x...
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
endpoint and print the parsed JSON response. `--input` for `wallet` is a JSON
file whose shape matches `DepositAddressTriggerDerivationFields`; the VM
family of the bundled action loaded for the call is taken from
`derivationFields.inputVmType`.

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

Because the source files import from URLs, this repo is **not** publishable as
a conventional npm library; consume the bundled per-VM action file
(`dist/actions/<env>/<vm>.js`) instead.

## Quick local derivation example

The local derivation helpers still accept an explicit `rootKeyHex`. This is for tests/dev tooling and mirrors what the Lit Action does after it retrieves the PKP private key inside the TEE.

```sh
npx tsx -e '
import {
  deriveAccount,
  deriveWallet,
  deriveWalletFromExtendedPublicKey,
  signWithWallet,
} from "./src/derivation/index.ts";

const rootKeyHex = "0x" + "11".repeat(32);
const vmType = "ethereum-vm";
const indexes = [0];
const messageHex = "0x" + "22".repeat(32);

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

const signed = await signWithWallet(rootKeyHex, vmType, indexes, messageHex);
console.log("signed", signed);
'
```

Change `vmType` to `bitcoin-vm` or `solana-vm` to test other implementations. `indexes` is a non-empty array of unhardened uint31 child segments appended to the account path; in production the `wallet` and `sign` actions derive it from `derivationFields` (see below).

## Lit Action API

`src/action.ts` expects Lit `jsParams` shaped as follows.

### `account`

```json
{
  "pkpId": "0x...",
  "action": "account",
  "vmType": "ethereum-vm"
}
```

### `wallet`

```json
{
  "pkpId": "0x...",
  "action": "wallet",
  "derivationFields": {
    "inputVmType": "solana-vm",
    "outputVmType": "ethereum-vm",
    "outputChainId": "1",
    "outputCurrency": "0x...",
    "outputRecipient": "0x...",
    "solver": "0x...",
    "pricingOracle": "0x...",
    "depositor": "0x...",
    "refundRecipient": "0x...",
    "slippageBps": "50"
  }
}
```

The wallet action derives the same eight-segment unhardened path from `derivationFields` that `sign` uses. The VM family is taken from `derivationFields.inputVmType`.

### `sign`

`sign` accepts a `trigger`, its oracle `attestation`, and one or more
VM-native `transactions` to sign with the derived deposit wallet.

```json
{
  "pkpId": "0x...",
  "action": "sign",
  "trigger": {
    "input": { "vmType": "ethereum-vm", "chainId": "...", "currency": "0x...", "amount": "..." },
    "derivationFields": {
      "inputVmType": "ethereum-vm",
      "outputVmType": "ethereum-vm",
      "outputChainId": "1",
      "outputCurrency": "0x...",
      "outputRecipient": "0x...",
      "solver": "0x...",
      "pricingOracle": "0x...",
      "depositor": "0x...",
      "refundRecipient": "0x...",
      "slippageBps": "50"
    },
    "orderId": "0x...",
    "nonce": "1",
    "currencies": [],
    "prices": [],
    "extraData": "0x"
  },
  "attestation": {
    "chainId": 421614,
    "depositAddressManager": "0x...",
    "triggerHash": "0x...",
    "signatures": [{ "oracleSigner": "0x...", "signature": "0x..." }]
  },
  "transactions": [{ "unsignedTransaction": "0x02..." }]
}
```

The action recomputes the trigger hash, verifies the attestation signatures against bundled environment config, derives an eight-segment unhardened child path solely from `trigger.derivationFields`, and signs every supplied transaction with the derived deposit wallet.

Each transaction is passed pre-encoded so the action just signs and (where applicable) reserializes:

- `ethereum-vm`: `{ unsignedTransaction }` — hex-encoded RLP unsigned transaction. EIP-155 legacy and typed transactions (EIP-1559, EIP-2930, EIP-4844, …) are supported; the encoded payload itself carries the type. Pre-EIP-155 legacy transactions (no chain id) are rejected. The caller builds it via e.g. viem's `serializeTransaction` (nonce, gas, fees, chain id, etc. are encoded inside). Returns `{ rawTransaction, transactionHash }`.
- `bitcoin-vm`: `{ sighashes }` — precomputed BIP143 segwit sighash digests as `0x`-prefixed 32-byte hex strings. Returns `{ signatures }` — compact ECDSA signatures matching the input order. The caller composes the final PSBT/transaction.
- `solana-vm`: `{ message }` — base64-encoded compiled message bytes. Only single-signer transactions are supported (the derived wallet is the fee payer at signer index 0). Returns `{ signature, rawTransaction }` where `rawTransaction` is the base64-encoded fully signed transaction.

The response is:

```json
{
  "wallet": { "vmType": "...", "indexes": [...], "path": "...", "address": "...", "publicKey": "..." },
  "triggerHash": "0x...",
  "signedTransactions": [ ... ]
}
```

Notes:

- `pkpId` is always required.
- `wallet` and `sign` derive the child path from `derivationFields`; neither takes raw indexes.
- `sign` requires at least one transaction.
- Derivation fields map to an eight-segment path of unhardened uint31 indexes (~248 bits of effective collision resistance).

## Environment config

Environment config lives under `environments/`:

```txt
environments/dev.json
```

The Lit Action-facing constants are exposed from `src/config.ts` and are intended to be replaced at bundle time, following the same pattern as `../lit-allocator`:

```ts
export const ACTION_ENV = __ACTION_ENV__;
export const DEPOSIT_ADDRESS_MANAGER_ADDRESS = __DEPOSIT_ADDRESS_MANAGER_ADDRESS__;
export const HUB_EVM_CHAIN_ID = Number.parseInt(__HUB_EVM_CHAIN_ID__, 10);
export const ALLOWED_ORACLES = JSON.parse(__ALLOWED_ORACLES__) as string[];
export const ORACLE_SIGNATURE_THRESHOLD = Number.parseInt(__ORACLE_SIGNATURE_THRESHOLD__, 10);
```

Current dev config:

```json
{
  "name": "dev",
  "depositAddressManagerAddress": "0x1bff267aa51674fa536da3873188a41a9c05cf44",
  "hubEvmChainId": 421614,
  "allowedOracles": [
    "0xcda3c24706c1a5eea958a988693e8a838d520af9",
    "0xf24a399259f47c6360d00da3793eca9cc6ad1caa"
  ],
  "oracleSignatureThreshold": 2
}
```

## Architecture

Only `action.ts`, `action-env.d.ts`, and `config.ts` live at `src/` root; everything else is organized into subdirectories:

```txt
src/
  action.ts                       # Lit Action entry + per-action handlers
  action-env.d.ts                 # Lit globals
  config.ts                       # bundle-time env constants
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
      VmWalletDeriver.ts          # abstract base / shared orchestration
      Secp256k1VmWalletDeriver.ts # shared secp256k1 account derivation
      EthereumVmWalletDeriver.ts  # ethereum-vm implementation
      BitcoinVmWalletDeriver.ts   # bitcoin-vm implementation
      SolanaVmWalletDeriver.ts    # solana-vm implementation
```

`src/derivation/index.ts` is the package's public entrypoint — it re-exports the types from `common/types.ts`, the `derivationFieldsToIndexes` helper, and the derivation/signing API.

## Key derivation

For each VM, the package first derives VM-specific seed material:

- `HKDF-SHA256`
- salt: `"lit-deposit-addresses"`
- info: VM type (`ethereum-vm`, `bitcoin-vm`, `solana-vm`)
- input key material: the PKP private key inside Lit, or explicit `rootKeyHex` in local helpers

It then uses `@metamask/key-tree` for HD derivation:

- `ethereum-vm`: secp256k1 BIP32
- `bitcoin-vm`: secp256k1 BIP32
- `solana-vm`: `ed25519Bip32` / CIP-3-style derivation

### Paths

The full path is the VM's account path followed by every entry in `indexes`:

- `ethereum-vm`: account path `m/44'/60'/0'/0`, child path `.../<i0>/<i1>/.../<iN>`
- `bitcoin-vm`: account path `m/84'/0'/0'/0`, child path `.../<i0>/<i1>/.../<iN>`, native segwit `bc1...` addresses
- `solana-vm`: account path `m/44'/501'/0'/0`, child path `.../<i0>/<i1>/.../<iN>`

For `wallet` and `sign`, the eight-segment `indexes` array is computed as `keccak256(abi.encode(derivationFields))` split into eight 32-bit words with the top bit of each cleared.

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
  signWithWallet,
  signTransactionsWithWallet,
  getSupportedVmTypes,
} from "./src/derivation/index.js";
```

### `deriveAccount(rootKeyHex, vmType)`

Derives the account-level public root.

For secp256k1 VMs, `extendedPublicKey` is a standard BIP32 xpub.

For `solana-vm`, `extendedPublicKey` is a JSON-serialized neutered `SLIP10Node` from `@metamask/key-tree`, including public key, chain code, curve, and metadata needed for public child derivation.

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

### `signWithWallet(rootKeyHex, vmType, indexes, messageHex)`

Signs the raw `messageHex` with the child wallet at `indexes`.

Signature formats:

- `ethereum-vm`: `0x{r}{s}{v}` with `v = 27/28`
- `bitcoin-vm`: `0x{r}{s}` compact 64-byte ECDSA signature
- `solana-vm`: `0x...` 64-byte Ed25519 signature

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
- VM-specific wallet formatting (Ethereum / Bitcoin / Solana)
- raw-message signature verification for all VMs
- transaction signing for all VMs (Ethereum: parse-and-recover, Bitcoin: per-input ECDSA verification, Solana: Ed25519 verification + signed-transaction layout)
- trigger attestation signature verification
- derivation-fields-to-indexes determinism and sensitivity
- invalid index / empty input rejection
