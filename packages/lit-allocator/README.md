# Lit Allocator

Lit Actions that sign Relay allocator withdrawals. This is a separate protocol
component from [`lit-deposit-address`](../lit-deposit-address): allocator
actions release funds on the destination chain, while deposit-address actions
move funds from per-order input wallets into the protocol.

The allocator actions are not general-purpose signers. They only sign hashes
that the Relay Hub allocator recorded for a specific withdrawal and that the
configured oracle threshold attested to.

## Protocol flow

1. `RelayAllocator` and the destination payload builder validate a withdrawal
   and record the VM-native hashes that must be signed.
2. The caller requests a withdrawal attestation from the Relay oracle.
3. The caller executes the action bundle for the target environment and VM,
   passing the withdrawal, attestation, PKP id, and a usage API key.
4. Inside Lit's TEE, the action retrieves the PKP private key and derives a
   VM-specific key with HKDF-SHA256.
5. The action recomputes the withdrawal hash, verifies the allocator address,
   Hub chain id, oracle signatures, and signature threshold, then signs every
   attested hash.
6. The caller inserts the signatures into the payload and submits it to the
   destination chain.

The PKP private key and derived VM keys never leave the TEE. The allocator
address, Hub chain id, oracle allowlist, and threshold are compiled into each
environment bundle and cannot be overridden by the caller.

## Actions

Each VM has its own bundle under `dist/actions/<env>/`.

| `action`       | Result                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet`       | Returns the wallet address derived from the PKP for the selected VM.                                                                        |
| `sign`         | Verifies a `WithdrawRequestAttestation` and returns one signature for each entry in `hashesToSign`.                                         |
| `changePubKey` | Lighter-only operation that signs a `changePubKey` transaction to one of the configured Lighter gateways, selected by `gatewayChainId`.     |
| `onboard`      | Atlas-only operation that signs the bind opening the depository's wallet, with only its expiry and the accepted terms chosen by the caller. |

Source entrypoints exist for `gateway-vm`, `ethereum-vm`, `bitcoin-vm`,
`tron-vm`, `solana-vm`, `ton-vm`, `hyperliquid-vm`, `lighter-vm`, `xrp-vm`,
`hedera-vm`, and `atlas-vm`. The currently released subset is defined by the
matrix in [`@relay-protocol/lit-actions`](../lit-actions).

The active protocol environments are `dev`, `stag`, and `prod`. A legacy
`test` configuration remains in the source package but is not an active
protocol deployment.

## Environment configuration

Each file in `environments/` contains the values embedded in that
environment's bundles:

```json
{
  "name": "dev",
  "allocatorAddress": "0x...",
  "hubEvmChainId": 0,
  "allowedOracles": ["0x...", "0x..."],
  "oracleSignatureThreshold": 2
}
```

Lighter environments additionally list the gateways the Lighter action may
register API keys on. Each entry is keyed by the EIP-155 chain id of the L1
hosting the gateway and carries its own API-key allowlist. An empty
`allowedApiKeys` is valid and fail-closed: `changePubKey` rejects every key
for that gateway until keys are added.

```json
"lighterGateways": [
  { "chainId": 1, "gateway": "0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7", "allowedApiKeys": [{ "apiKeyIndex": 4, "publicKey": "0x..." }] },
  { "chainId": 4663, "gateway": "0x94bab9693ba2f6358507effcbd372b0660afff9d", "allowedApiKeys": [] }
]
```

Chain id `1` is Lighter mainnet on Ethereum; `4663` is Robinhood Lighter on
Robinhood Chain.

Atlas environments set the deployment-specific fields of the `atlas` version
`1` EIP-712 transaction domain; the testnet salt is `keccak256("atlas/testnet")`.
Without `atlasDomain`, Atlas `sign` and `onboard` reject every request.

```json
"atlasDomain": { "chainId": 43003, "salt": "0xcc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338" }
```

Any configuration change modifies the bundle and requires a new Lit
deployment.

## Build and bundle

Run from the repository root:

```sh
yarn workspace @relay-protocol/lit-allocator build
yarn workspace @relay-protocol/lit-allocator bundle:actions -- --env dev
```

`build` type-checks and compiles the source package. `bundle:actions` writes one
standalone JavaScript action per VM to `dist/actions/dev/`, with the selected
environment configuration embedded in the code.

Production consumers should use the canonical code and configuration exported
by [`@relay-protocol/lit-actions`](../lit-actions), not copy files from
`dist/actions/`.

## Register an environment with Lit

The package-specific setup command registers the allocator bundles, PKP, group,
and usage API key. It requires an explicit environment and account mode:

```sh
# Managed Lit account
yarn workspace @relay-protocol/lit-allocator setup -- \
  --env dev --mode api-key \
  --account-api-key <account-api-key> \
  --create-pkp

# Wallet-owned ChainSecured account using an existing PKP
yarn workspace @relay-protocol/lit-allocator setup -- \
  --env dev --mode chain-secured \
  --account-api-key <account-api-key> \
  --private-key 0x<admin-key> \
  --pkp-id 0x<pkp-address>
```

The command manages the `allocator-<env>` group and
`allocator-<env>-usage-key`, registers the environment's per-VM actions, and
prints the PKP, usage key, and action CIDs needed by callers. Pass `--dry-run`
to inspect the changes first.

Actions are registered as `allocator-<env>-action-<vm>-<version>`, where the
version is `ACTION_VERSIONS[env]` in `scripts/env.ts` (`v3` in every environment). Older versions stay
registered and permitted so callers can be promoted one at a time. Pass
`--prune-old-versions` only once no caller executes the previous version.

Account modes, PKP creation, ownership, billing, usage-key rotation, and
MPC/multisig `--calldata` mode are documented once in
[`lit-helpers`](../lit-helpers#action-package-setup).

To create another usage key for the allocator group:

```sh
yarn workspace @relay-protocol/lit-allocator create-usage-api-key -- \
  --env dev --mode api-key \
  --account-api-key <account-api-key> \
  --name allocator-dev-usage-key-2 \
  --description "Usage key for Lit Allocator"
```

## Invoke an action locally

The client commands load a local environment bundle and execute it through
Lit's API. They are useful for deployment checks and integration testing.

```sh
# Return the PKP-derived Ethereum allocator address
yarn workspace @relay-protocol/lit-allocator wallet -- \
  --env dev \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --vm-type ethereum-vm

# Verify an attestation and sign its hashes
yarn workspace @relay-protocol/lit-allocator sign -- \
  --env dev \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --vm-type ethereum-vm \
  --input request.json

# Sign a Lighter changePubKey for the Robinhood Lighter gateway
yarn workspace @relay-protocol/lit-allocator change-pub-key -- \
  --env dev \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --gateway-chain-id 4663 \
  --account-index <uint48> --api-key-index <uint8> --public-key <hex> \
  --tx-nonce <nonce> --gas-price <wei> --gas-limit <gas>

# Sign the bind that opens the Atlas depository's wallet
yarn workspace @relay-protocol/lit-allocator onboard-atlas-depository -- \
  --env test \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --terms "<id>@<version> 0x<contentHash>" --expires-at <unix-seconds>
```

`request.json` contains the exact `withdrawRequest` and oracle `attestation`.
See the [allocator integration recipe](./docs) for the request flow, action
invocation, and response checks.

## VM-specific behavior

- `gateway-vm` requires `destinationVmType` to be `ethereum-vm` or
  `solana-vm`. It signs the first Gateway hash with secp256k1 and uses the
  destination curve for the remaining hashes.
- `lighter-vm` also supports `changePubKey`, restricted to the gateways and API
  keys embedded in the environment configuration; the caller selects the
  gateway with `gatewayChainId`.
- `xrp-vm` returns `signingPubKey` from `wallet` and emits canonical low-S DER
  signatures for XRPL transactions.
- `hedera-vm` returns the public key and EVM alias. Use
  `create-hedera-depository` to create and verify the corresponding Hedera
  entity id without exposing the derived private key.
- `atlas-vm` returns the derived address, which is the depository's Atlas
  Main account. `sign` also takes the builder's `transfer`,
  rebuilds its transferId under the embedded domain, and signs only a transfer
  out of the derived account whose transferId is the one attested hash and
  whose expiry is ahead by at most 14 days. `onboard` signs the one bind that
  opens the wallet: the account binds its own key reduce-only with no Builder
  Fee at gapless nonce 1, accepting the `bind.statements` terms line, with
  `bind.expiresAt` at most a day ahead. Signatures carry Atlas's raw recovery
  id (v = 0 or 1). `onboard-atlas-depository` prints that bind as the raw
  envelope and statements `atlas.sendWalletReadyRequest` takes.

## Security checks

Before signing, the action:

1. computes `keccak256(abi.encode(withdrawRequest))`;
2. matches the attestation's Hub chain id and allocator against the embedded
   environment values;
3. matches the attested withdrawal hash against the computed hash;
4. rejects an empty `hashesToSign` array;
5. verifies distinct EIP-712 oracle signatures against the embedded allowlist;
6. requires the embedded oracle threshold; and
7. signs only the hashes contained in the verified attestation.

## Development

```sh
yarn workspace @relay-protocol/lit-allocator test
yarn workspace @relay-protocol/lit-allocator lint
yarn workspace @relay-protocol/lit-allocator format:check
```

The tests run locally without a Lit network connection.

## Deployment rule

Lit Action code is content-addressed and immutable by CID. Any source,
dependency, or environment-configuration change requires rebundling,
registering the new CIDs for every affected environment and VM, updating
`@relay-protocol/lit-actions`, and completing downstream integration testing.
Follow the shared [deployment checklist](../lit-actions/DEPLOYMENT.md).
