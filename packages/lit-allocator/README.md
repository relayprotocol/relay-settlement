# Lit Allocator

A multi-chain wallet allocator using [Lit Protocol](https://litprotocol.com) (Chipotle). It derives deterministic VM-specific wallets from a Lit PKP private key via HKDF-SHA256, verifies oracle withdraw request attestations inside Lit Actions, and only signs hashes that an allowlisted oracle threshold has attested are included in the allocator contract.

**No allocator server** — signing is invoked just-in-time via environment-specific Lit Actions running inside Lit's TEE nodes.

## How It Works

```
Caller
  │
  └─ POST Lit Action execution
       jsParams: { pkpId, action, withdrawRequest, attestation }
       code: dist/actions/<env>/<vm>.js
       │
       └─► VM-specific Lit Action (runs in TEE)
              │
              ├─ pkpKey = await Lit.Actions.getPrivateKey({ pkpId })
              ├─ vmKey = HKDF-SHA256(pkpKey, salt="relay-allocator", info=vmType)
              ├─ allocatorAddress = hardcoded build-time env constant
              ├─ verify oracle EIP-712 attestation:
              │    (chainId, allocator, withdrawRequestHash, hashesToSign[])
              │    signed by ≥ oracleSignatureThreshold allowlisted oracles
              └─ sign each hash in hashesToSign with derived VM key
```

The PKP private key is retrieved inside the TEE via `Lit.Actions.getPrivateKey()` and never leaves the enclave. The allocator address, allowed oracle set, and signature threshold are **not caller-provided** — they are compiled into the action bundle per environment.

## Environments

```txt
environments/
  dev.json
  stag.json
  prod.json
```

Each environment config contains non-secret build-time configuration:

```json
{
  "name": "dev",
  "allocatorAddress": "0x...",
  "hubEvmChainId": 421614,
  "allowedOracles": ["0x...", "0x..."],
  "oracleSignatureThreshold": 2,
  "lighterAllowedApiKeys": [{ "apiKeyIndex": 5, "publicKey": "0x..." }],
  "lighterGateway": "0x...",
  "lighterGatewayChainId": 1
}
```

Bundling creates separate Lit Action code for each environment:

```txt
dist/actions/<env>/ethereum.js
dist/actions/<env>/tron.js
dist/actions/<env>/solana.js
dist/actions/<env>/ton.js
dist/actions/<env>/bitcoin.js
dist/actions/<env>/hyperliquid.js
dist/actions/<env>/lighter.js
dist/actions/<env>/xrp.js
```

…one such set per environment (`dev`, `stag`, `prod`).

Because each bundle hardcodes the allocator address, oracle allowlist, and signature threshold, each environment has distinct action code/CIDs and can be registered under different Lit accounts, wallets, and groups.

## Build

```sh
npm install
npm run build
```

`npm run build` runs TypeScript compilation and bundles all environment actions. To bundle a single environment:

```sh
npm run bundle:actions -- --env dev
```

The Lit Actions use jsDelivr ESM imports in the generated bundles, matching Lit's documented import style.

## Setup

Setup is environment-specific and requires an explicit `--env` plus a `--mode`. The account is always identified by `--account-api-key`; ChainSecured mode additionally requires the admin wallet's `--private-key`.

```sh
# Managed (API-mode) account
npm run setup -- --env dev --mode api-key \
  --account-api-key <account-api-key> \
  (--create-pkp | --pkp-id <address>) \
  [--dry-run]

# Wallet-owned (ChainSecured) account
npm run setup -- --env dev --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-wallet-key> \
  (--create-pkp | --pkp-id <address>) \
  [--dry-run]

# MPC/multisig-owned (ChainSecured) account — emit calldata to relay, don't broadcast
npm run setup -- --env dev --mode chain-secured --calldata \
  --account-api-key <account-api-key> \
  --pkp-id 0x<existing-pkp>
```

In ChainSecured mode the account hash queried on-chain is `keccak256(toUtf8Bytes(accountApiKey))`, so the same `--account-api-key` identifies the account in both modes. Shared setup backend constants live in `../lit-helpers/src/setup/backend-chain-secured.ts`; shared account-helper script constants live in `../lit-helpers/src/chainSecured.ts`.

Pass `--dry-run` to perform read-only discovery and print which PKPs, groups, actions, and usage keys already exist, plus which resources would be created, updated, or pruned in a normal run.

Pass `--calldata` (ChainSecured only) when the account is owned by an MPC/multisig wallet: setup runs read-only discovery and prints the contract calldata for whatever is out of sync as a batch to relay through the owner, instead of broadcasting. It requires `--pkp-id` and an already-provisioned usage key (PKP/usage-key minting need a live admin signature). See the [lit-helpers calldata mode docs](../lit-helpers/README.md#calldata-mode-mpc--multisig-owned-accounts).

Setup is idempotent and will:

- mint a fresh PKP (`--create-pkp`) or reuse an existing one (`--pkp-id`)
- create or reuse the environment group (`allocator-<env>`)
- add the PKP to the group
- register / refresh the per-VM action bundles and prune stale `allocator-<env>-*` registrations
- create or reuse the environment usage API key (`allocator-<env>-usage-key`)
- print the environment variables needed for signing

To mint an additional usage API key for the existing environment group:

```sh
npm run create-usage-api-key -- --env dev --mode api-key \
  --account-api-key <account-api-key> \
  --name allocator-dev-usage-key-2 \
  --description "Usage key for Lit Allocator"

npm run create-usage-api-key -- --env dev --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-wallet-key> \
  --name allocator-dev-usage-key-2 \
  --description "Usage key for Lit Allocator"
```

## Shared Account Helpers

The conversion, ownership, credits, and top-up commands are action-agnostic and run from `../lit-helpers`.

## Converting an Account to ChainSecured

Migrate a managed (API-mode) account so it's owned by a wallet instead of
the Lit-internal `api_payer` flow. The original `--account-api-key`
continues to identify the account on-chain afterwards (the on-chain account
hash is `keccak256(toUtf8Bytes(accountApiKey))`), so groups, actions, PKPs,
usage keys, and billing all stay attached.

```sh
yarn workspace @relay-protocol/lit-helpers convert-to-chain-secured -- \
  --account-api-key <existing-account-api-key> \
  --new-admin-private-key 0x<new-admin-wallet-key>
```

Under the hood: signs an EIP-712 `ConvertAccount` envelope with the new
admin wallet's key and POSTs it to `/core/v1/convert_to_chain_secured_account`
with `X-Api-Key: <existing-account-api-key>`. After this, all admin writes
(group / action / PKP / usage-key mutations) must be signed by the new admin
wallet.

## Transferring ChainSecured Account Ownership

Reassign a ChainSecured account's admin wallet to a different wallet. Calls
the AccountConfig diamond's `transferChainSecuredAccountOwnership` function
directly (no HTTP endpoint exists for this) signed by the **current** admin
wallet.

```sh
# By new admin's address (e.g. transferring to someone else)
yarn workspace @relay-protocol/lit-helpers transfer-ownership -- \
  --account-api-key <existing-account-api-key> \
  --current-admin-private-key 0x<current-admin-wallet-key> \
  --new-admin-address 0x<new-admin-wallet-address>

# By new admin's private key (e.g. you hold both keys; address is derived)
yarn workspace @relay-protocol/lit-helpers transfer-ownership -- \
  --account-api-key <existing-account-api-key> \
  --current-admin-private-key 0x<current-admin-wallet-key> \
  --new-admin-private-key 0x<new-admin-wallet-key>
```

Contract semantics (from chipotle PR #346):

- the new admin must be non-zero, differ from the current admin, and not
  already be admin of any other account
- the master `apiKeyHash` and billing wallet are preserved — groups, actions,
  PKPs, usage keys, and credits all carry over
- after the transfer, admin writes must be signed by the new admin wallet
- you only need the **address** of the new admin (not its private key); the
  new owner takes possession by holding the key locally and signing future
  writes themselves. As a convenience, if you happen to hold the new admin's
  private key, pass `--new-admin-private-key` instead and the address is
  derived locally

## Verifying ChainSecured Ownership

Prove which wallet currently owns a ChainSecured account, without spending
gas or sending a transaction. The script simulates a self-transfer-of-
ownership via `eth_call`, then decodes the contract's revert to distinguish
the two diagnostic outcomes:

- revert `InvalidRequest("must differ from current admin")`
  → the wallet is the current admin (auth gate passed, then the contract
  noticed the self-transfer)
- revert `NoAccountAccess(...)`
  → the wallet is **not** the current admin (auth gate failed)

Other revert paths (`AccountDoesNotExist`, `Account is not ChainSecured`,
etc.) are mapped to actionable error messages.

```sh
# By admin address
yarn workspace @relay-protocol/lit-helpers verify-ownership -- \
  --account-api-key <existing-account-api-key> \
  --admin-address 0x<candidate-admin-address>

# By admin private key (address derived locally; no signing happens)
yarn workspace @relay-protocol/lit-helpers verify-ownership -- \
  --account-api-key <existing-account-api-key> \
  --admin-private-key 0x<candidate-admin-key>
```

No transaction is broadcast and the private key (if provided) is only used
to derive the candidate address — the script does not sign anything.

## Reading Credits

```sh
yarn workspace @relay-protocol/lit-helpers credits -- --account-api-key <account-api-key>
```

Calls `GET /billing/balance` and prints the account-level credit balance that
decrements per request. Works for both API-mode and ChainSecured accounts.
Output fields:

- `balance_display` — human-readable form, e.g. `"$5.00 credit"`
- `balance_cents` — negative means credits remaining, zero means exhausted,
  positive means amount owed

Note: the on-chain `UsageApiKey.balance` field (returned by `list_api_keys`)
is unrelated — it is always `0` in this deployment since usage keys are
minted with `balance: 0`. The real billing balance lives at `/billing/balance`.

## Topping Up With Crypto

Lit/Chipotle support adding credits by paying with cryptocurrency (USDC, ETH,
SOL, USDP across Ethereum/Solana/Polygon) through Stripe's crypto on-ramp.
The billing endpoints are the same as for card payments — Stripe simply
renders crypto as another payment method.

```sh
yarn workspace @relay-protocol/lit-helpers top-up -- --account-api-key <account-api-key> --amount-cents 2500   # $25.00
```

Flow:

1. Fetch the Stripe publishable key and create a Stripe PaymentIntent.
2. Boot a tiny local web server with a one-page Stripe.js Payment Element.
3. Open your default browser to the local URL; connect a wallet (MetaMask,
   Coinbase Wallet, WalletConnect, …) and approve the on-chain transaction.
4. Once Stripe confirms settlement (typically 1–5 minutes for crypto), it
   redirects back to the local server.
5. The CLI calls `/billing/confirm_payment` to credit the account, then
   `/billing/balance` to print the new balance.

Requires the **account** API key (`--account-api-key`); usage keys don't
have billing scope. Minimum payment is `$5.00` (500 cents).

## CLI Usage

Client CLIs invoke the deployed actions via the Chipotle REST API:

```sh
# Print the derived VM-specific wallet address for the PKP
npm run wallet -- --env dev \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --vm-type <ethereum-vm|tron-vm|solana-vm|ton-vm|bitcoin-vm|hyperliquid-vm|lighter-vm|xrp-vm>

# Verify an oracle attestation and sign every hash it attests
npm run sign -- --env dev \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --vm-type <ethereum-vm|tron-vm|solana-vm|ton-vm|bitcoin-vm|hyperliquid-vm|lighter-vm|xrp-vm> \
  --input request.json

# Sign a Lighter gateway changePubKey transaction for API-key setup
npm run changepubkey -- --env dev \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --account-index <uint48> \
  --api-key-index <uint8> \
  --public-key <hex> \
  --tx-nonce <nonce> \
  --gas-price <wei> \
  --gas-limit <gas>
```

`request.json` format:

```json
{
  "withdrawRequest": {
    "chainId": "ethereum-mainnet",
    "depository": "0x...",
    "currency": "0x...",
    "amount": "10",
    "spenderChainId": "ethereum-mainnet",
    "spender": "0x...",
    "receiver": "0x...",
    "data": "0x",
    "nonce": "0x<32 bytes>"
  },
  "attestation": {
    "chainId": 421614,
    "allocator": "0x...",
    "withdrawRequestHash": "0x...",
    "hashesToSign": ["0x..."],
    "signatures": [{ "oracleSigner": "0x...", "signature": "0x..." }]
  }
}
```

The `attestation` object is the direct response from `POST /attestations/withdraw-requests/v1` on the Relay oracle. The caller does **not** pass an allocator address — the action verifies it against the value embedded in the bundle.

The Lighter action also supports `action: "changePubKey"` for API-key setup. It signs a Lighter gateway `changePubKey(uint48,uint8,bytes)` legacy EIP-155 transaction only when the requested `(apiKeyIndex, publicKey)` pair is present in the environment's `lighterAllowedApiKeys` config. The gateway address and gateway chain id are also embedded from `lighterGateway` and `lighterGatewayChainId`. The caller-provided `changePubKey` params are: `accountIndex`, `apiKeyIndex`, `publicKey`, `txNonce`, `gasPrice`, and `gasLimit`.

## Oracle Attestation

The oracle endpoint expected by the Lit Action:

```
POST /attestations/withdraw-requests/v1

Request body:
  { chainId, currency, amount, spenderChainId, spender, receiver, data, nonce, hashIndexes, requestPeerSignatures }

Response:
  {
    "withdrawRequest": {
      "chainId": 421614,
      "allocator": "0x...",
      "withdrawRequestHash": "0x...",
      "hashesToSign": ["0x..."],
      "signatures": [{ "oracleSigner": "0x...", "signature": "0x..." }]
    }
  }
```

For each requested `hashIndex` the oracle resolves `allocator.hashesToSign[withdrawRequestHash][hashIndex]` on-chain and includes the resulting bytes32 in `hashesToSign`. The Lit Action verifies the oracle's EIP-712 signatures, then signs every hash in `hashesToSign` with the VM-derived key, returning one signature per hash.

The `xrp-vm` `wallet` action additionally returns a `signingPubKey` field (the 33-byte compressed secp256k1 public key), because XRPL embeds the signing key verbatim in every transaction's `SigningPubKey` field. That same key is the value baked into `XrpVmPayloadBuilder`'s `SIGNING_PUBKEY` constructor argument on chain. It is a fixed per-PKP constant needed once at deploy time, so it is surfaced only on `wallet` and not repeated on every `sign` response. XRP signatures are canonical, low-S, DER-encoded ECDSA (the encoding XRPL's `TxnSignature` expects) rather than the fixed-width `r ‖ s ‖ v` form the other secp256k1 actions emit.

## Programmatic Usage

```typescript
import {
  CHIPOTLE_API_BASE_URL,
  executeLitAction,
  type AllocatorClient,
} from "./scripts/client/index.js";

const client: AllocatorClient = {
  apiBaseUrl: CHIPOTLE_API_BASE_URL,
  apiKey: process.env.LIT_API_KEY!, // a usage API key
  pkpId: process.env.LIT_PKP_ID!, // PKP wallet address
  envName: "dev",
};

// Derive a VM-specific wallet address
const wallet = await executeLitAction(client, "ethereum-vm", { action: "wallet" });
// { vmType: "ethereum-vm", address: "0x..." }

// Verify an oracle attestation and sign every attested hash
const result = await executeLitAction(client, "ethereum-vm", {
  action: "sign",
  withdrawRequest,
  attestation, // direct response from POST /attestations/withdraw-requests/v1
});
// { vmType, address, withdrawRequestHash, results: [{ hash, signature }] }
```

## Architecture

```txt
src/                                 # Lit Action source (bundled into dist/)
  action-env.d.ts                    # Lit runtime + jsDelivr module type declarations
  config.ts                          # Build-time constants (allocator, oracles, threshold)
  common/
    abi.ts                           # WithdrawRequest ABI encoding and hash computation
    attestation.ts                   # Oracle attestation EIP-712 signature verification
    bytes.ts                         # Hex/byte helpers
    crypto.ts                        # Keccak-256 + HKDF-SHA256 key derivation
    index.ts                         # Public re-exports for the common module
    types.ts                         # Shared types (WithdrawRequest, attestation)
  vm/
    ethereum-vm.ts                   # Ethereum Lit Action (secp256k1 signing)
    bitcoin-vm.ts                    # Bitcoin Lit Action (secp256k1 signing, bc1 address)
    solana-vm.ts                     # Solana Lit Action (Ed25519 signing)
    ton-vm.ts                        # TON Lit Action (Ed25519 signing, 0:<hex> address)
    hyperliquid-vm.ts                # Hyperliquid Lit Action (secp256k1 signing, EVM address)
    lighter-vm.ts                    # Lighter Lit Action (secp256k1 signing + ChangePubKey)
    xrp-vm.ts                        # XRP Ledger Lit Action (secp256k1 DER signing, r... address)

scripts/
  bundle-actions.ts                  # Bundles src/vm/*.ts into dist/actions/<env>/*.js
  env.ts                             # Environment config loading and --env parsing
  setup.ts                           # Idempotent Chipotle provisioning using @relay-protocol/lit-helpers/setup
  client/
    index.ts                         # AllocatorClient + executeLitAction
    wallet.ts                        # CLI: derive VM-specific wallet address
    sign.ts                          # CLI: verify attestation + sign hashes
    change-pub-key.ts                # CLI: sign Lighter ChangePubKey transactions

environments/
  dev.json                           # Dev environment config
  stag.json                          # Staging environment config
  prod.json                          # Production environment config

test/
  src/common/                        # Unit tests for src/common utilities
  src/vm/                            # Unit tests for VM action helpers
```

The `setup` script uses the shared `SetupBackend` interface and implementations exported from `@relay-protocol/lit-helpers/setup`. The package-specific setup script owns allocator environment loading, action bundle discovery, and resource naming.

## Key Derivation (HKDF-SHA256)

| Parameter          | Value                  |
| ------------------ | ---------------------- |
| Algorithm          | HKDF-SHA256 (RFC 5869) |
| IKM                | PKP private key bytes  |
| Salt               | `"relay-allocator"`    |
| Info (Ethereum)    | `"ethereum-vm"`        |
| Info (Bitcoin)     | `"bitcoin-vm"`         |
| Info (Tron)        | `"tron-vm"`            |
| Info (Solana)      | `"solana-vm"`          |
| Info (TON)         | `"ton-vm"`             |
| Info (Hyperliquid) | `"hyperliquid-vm"`     |
| Info (Lighter)     | `"lighter-vm"`         |
| Info (XRP)         | `"xrp-vm"`             |
| Output             | 32 bytes               |

All VM actions use the same HKDF implementation from `src/common/crypto.ts`.

## Attestation Verification

The Lit Action verifies the oracle attestation before signing. For each request it:

1. Computes `keccak256(abi.encode(withdrawRequest))` locally.
2. Checks `attestation.chainId` equals the bundle-time `HUB_EVM_CHAIN_ID`.
3. Checks `attestation.allocator` equals the bundle-time `ALLOCATOR_ADDRESS`.
4. Checks `attestation.withdrawRequestHash` equals the locally computed hash.
5. Checks `attestation.hashesToSign` is non-empty.
6. Verifies each oracle signature is a valid EIP-712 sig over `(chainId, allocator, withdrawRequestHash, hashesToSign[])` by an address in the bundle-time `ALLOWED_ORACLES` set.
7. Checks the number of distinct verified oracle addresses meets `ORACLE_SIGNATURE_THRESHOLD`.
8. Signs every entry in `hashesToSign` with the derived VM key, returning one signature per hash.

The oracle's EIP-712 domain:

```json
{
  "name": "WithdrawRequest",
  "version": "1",
  "chainId": "<hubEvmChainId>",
  "verifyingContract": "0x0000000000000000000000000000000000000000"
}
```

## Testing

```sh
npm test
```

Tests cover:

- `src/common` utilities: byte helpers, crypto, HKDF, ABI encoding/hashing
- oracle attestation EIP-712 signature verification
- VM action wallet derivation and required input validation

The tests run locally without a Lit network connection.

## Development

```sh
npm run format        # prettier --write .
npm run format:check  # prettier --check .
npm run lint          # tsc --noEmit && eslint .
npm run build         # tsc + bundle every environment's actions
npm test              # vitest run test
```

## Security Model

- The PKP private key is managed by Lit's network via DKG.
- At execution time, `Lit.Actions.getPrivateKey({ pkpId })` reconstructs the full key inside a single TEE node.
- The derived VM-specific private keys never leave the TEE.
- The allocator address, hub chain ID, allowed oracle set, and oracle signature threshold are compiled into each environment-specific action bundle — they cannot be overridden by the caller at runtime.
- Caller-supplied oracle attestations are verified against the hardcoded allowlist and threshold inside the TEE. A compromised or rogue oracle cannot forge signatures unless it controls ≥ `oracleSignatureThreshold` allowlisted keys.
- Lit group/action/PKP permissions are isolated per environment and can be controlled by separate accounts or chain-secured wallets.
- The final Lit Action code is immutable by CID once registered.
