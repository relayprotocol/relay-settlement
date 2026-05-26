# Relay Protocol

## Deployments (Foundry)

Deployments live as Foundry scripts under [`script/`](./script). Each script is
configured via environment variables and runs with `forge script`. Deploys are
broadcast to the chain specified by `--rpc-url`; verification is handled by
forge against Etherscan's v2 multi-chain API (the same API key works for every
supported explorer) via `--verify --etherscan-api-key $ETHERSCAN_API_KEY`.

Common environment variables:

- `DEPLOYER_PRIVATE_KEY` – deployer key (hex, 0x-prefixed). Required for all
  deploy scripts. `PRIVATE_KEY` is honoured as a fallback.
- `ETHERSCAN_API_KEY` – v2 multi-chain Etherscan API key. Forwarded via
  `--etherscan-api-key`.

Yarn wrappers exist for each script so the CLI looks similar to the previous
Hardhat tasks. They pass through any additional flags (e.g. `--rpc-url`,
`--verify`).

### Allocator

```sh
# Deploy the main RelayAllocator contract
OWNER=<multisig-address> HUB=<relay-hub-address> ORACLE=<oracle-address> \
  yarn deploy:allocator --rpc-url $RPC_URL --verify --etherscan-api-key $ETHERSCAN_API_KEY

# Deploy the Config contract for the allocator
ALLOCATOR=<allocator-contract-address> \
  yarn deploy:allocator-config --rpc-url $RPC_URL --verify

# Deploy the EVM payload builder
CONFIG=<config-contract-address> \
  yarn deploy:ethereum-vm-payload-builder --rpc-url $RPC_URL --verify

# Deploy the Solana VM payload builder
CONFIG=<config-contract-address> \
  yarn deploy:solana-vm-payload-builder --rpc-url $RPC_URL --verify
```

`RelayAllocator` links the `Utils` library and `RelayMultisigSigner` /
`BitcoinDepositAddress` link `AuroraSdk`, `ChainSignatures`, etc. Forge
automatically deploys and links these libraries as part of the script run; for
deterministic addresses pass `--libraries 'contracts/Utils.sol:Utils:0x...'`
to reuse a pre-deployed copy (see `libraries.json` for canonical Aurora
addresses).

### Roles

```sh
# Grant APPROVED_WITHDRAWER_ROLE on the allocator
CONTRACT=<allocator-contract-address> ROLE=APPROVED_WITHDRAWER_ROLE \
  ACCOUNT=<address> yarn grant-role --rpc-url $RPC_URL

# Renounce a role held by the deployer
CONTRACT=<contract-address> ROLE=OPERATOR_ROLE \
  yarn renounce-role --rpc-url $RPC_URL
```

`ROLE` accepts either a plain string (hashed with keccak256) or a
`0x`-prefixed bytes32 hash.

### Legacy allocator orchestration tasks

The Hardhat tasks below remain available for flows that integrate with NEAR /
Aurora signing (initialization, payload signing, withdraw orchestration). They
will be migrated separately as they primarily depend on TypeScript SDKs rather
than EVM deployments.

```sh
# Initialize the allocator (requires 2 wNEAR on Aurora)
yarn hardhat allocator:init --allocator <allocator-contract-address>

# Set a payload builder for a specific chain
yarn hardhat allocator:set-payload-builder --builder <builder-address> --allocator <allocator-contract-address> --chain-id <depository-contract-chain> --depository <depository-contract-address>

# Submit withdraw request params (thru block explorer)
yarn hardhat allocator:submit-withdraw --allocator <allocator-address> --chain-id <depository-chain-id> --depository <depository-contract-address>

# Sign payload
yarn hardhat allocator:sign-payload --allocator <allocator-address> --chain-id <depository-chain-id> --depository <depository-contract-address> --nonce <nonce from withdraw request>

# Submit the withdrawal to the depository contract
yarn hardhat depository:withdraw --withdraw-request-hash <withdraw-request-hash> --allocator <allocator-address> --payload-builder-type <payload-builder-name>
```

We also have "end to end" tasks which can be used to deploy everything and submit transactions. This uses a lot of defaults, and roles are granted to the caller's address (you need to set the `DEPLOYER_PRIVATE_KEY` environment variable).

For EVM (Ethereum, L2... etc):

```bash
yarn run hardhat full:evm --network aurora-testnet --wnear 0x4861825E75ab14553E5aF711EbbE6873d369d146  --chain-id 84532 --depository 0x9229808f111ff3EAf6826736c74462fece0f6583
```

For Bitcoin. You first need to deploy the EVM version... because it provides the private key that needs to be supplied to the Bitcoin payload builder at deployment time (replace the last argument). Also, this script requires that you fund the Bitcoin address first (as the payload is construted from UTXO).

```bash
yarn run hardhat full:bitcoin --network aurora-testnet --wnear 0x4861825E75ab14553E5aF711EbbE6873d369d146 --recipient tb1q6xsu27js50xzvnwfgxrkhwj7a9rrch76wf7xxq --public-key 0x04e70427664177dee706e65274d3e7e7e28faa5ec10dedddf205ec49720ee9f154d4a4f09296f8f1695277413b13f78a656b72032a703d9be51baa28b733ae6376
```

### Testnet Faucet

Replace `<account-name>` (eg.`relayprotocol.testnet`) with a unique account name in the following commands

### Get NEAR in testnet

```
near account create-account sponsor-by-faucet-service <account-name> autogenerate-new-keypair save-to-keychain network-config testnet create
```

### Export private key and import in Meteor wallet

```
near account export-account <account-name> using-private-key network-config testnet
```

### Bridge to Aurora Testnet

Bridge to Aurora Testnet Via https://testnet.rainbowbridge.app/

## Relay Multisig Signer

A smart contract that can use Near's Chain Signatures (via Aurora) to sign hashes submitted from a Multisig. This lets the Relay team control smart contracts (and EOAs) on various chains (EVM, Bitcoin, Solana... etc) from a multisig wallet without sharing a private key.

We have deployed an instance of this contract on Aurora at `0xb538ee6515F9d16eBD0BACD0503733815c9b070c`.

### Example of flow:

Pre-requisite: add a `SAFE_API_KEY` env variable!

1. A transactions manifest file is created. It represents the transaction(s) to be executed on each chain. This file should be created from a script (it's format is validated when loaded by the scripts below).
2. It is possible to simulate all the transactions using `relay-multisig-signer:simulate --transactions <manifest.json>`
3. The hashes for each transaction are generated and submitted to the SAFE multisig using the task `relay-multisig-signer:submit --transactions <manifest.json> --relay-multisig-signer <multisig signer address>`
4. The signers on the multisig can verify that the SAFE transaction they are signing is correct by running `relay-multisig-signer:check-hashes --transactions <manifest.json> --relay-multisig-signer <multisig signer address> --safe-transaction-nonce <transaction number>`. If they match they can sign (approve the multisig tx).
5. Once the SAFE transaction has been executed, anyone can execute all the transactions from the bundle using
   `relay-multisig-signer:execute-transactions --transactions <manifest.json> --relay-multisig-signer <multisig signer address> --safe-transaction-nonce <transaction number>`

### Solana Program Upgrades

Deploy and upgrade Solana programs using a dual-wallet approach to minimize multisig transactions.

**Setup:**

```bash
# Create durable nonce account
yarn hardhat relay-multisig-signer:solana-create-nonce-account --rpc <rpc-url> --payer <private-key>

# Set nonce/buffer authority (same wallet handles both nonce and buffer operations)
export SOLANA_NONCE_AUTHORITY_PRIVATE_KEY=<private-key-base58>
```

**Generate upgrade transaction:**

```bash
# For initial deploy
bun tasks/relayMultisigSigner/scripts/generate-solana-upgrade-transaction.ts \
  --rpc <rpc-url> --program-path <program.so> --program-keypair <keypair.json> \
  --upgrade-authority <multisig-address> --nonce-account <nonce-address>

# For upgrade
bun tasks/relayMultisigSigner/scripts/generate-solana-upgrade-transaction.ts \
  --rpc <rpc-url> --program-path <program.so> --program-id <program-id> \
  --upgrade-authority <multisig-address> --nonce-account <nonce-address>
```

The `generate-solana-upgrade-transaction.ts` script only handles the deploy/upgrade infrastructure (buffer operations, program deployment). Contract-specific initialization, migration, or other business logic should be added as additional instructions or separate transactions in the manifest. Durable nonce is required due to long multisig signing times that cause recent blockhash expiration.

### Tron Transaction Support

Execute Tron transactions using the RelayMultisigSigner. Supports `TransferContract` and `TriggerSmartContract`. See `tasks/relayMultisigSigner/transactions/demo-tron-*.json` for examples.

**Run test:**

```bash
# Deploy and execute
yarn hardhat full:relay-multisig-signer:tron \
  --network aurora-testnet \
  --transaction-file tasks/relayMultisigSigner/transactions/demo-tron-transfer.json \
  --wnear <wnear-token-address>

# Using existing RelayMultisigSigner
yarn hardhat full:relay-multisig-signer:tron \
  --network aurora-testnet \
  --transaction-file tasks/relayMultisigSigner/transactions/demo-tron-transfer.json \
  --relay-multisig-signer <existing-address>
```

**For async submit/execute workflows:** Generate transaction headers (similar to Solana's Durable Nonce) to prevent expiration during multisig signing. Tron transactions have a maximum 24-hour expiration; the command generates 16-hour headers.

```bash
yarn hardhat relay-multisig-signer:generate-tron-headers --rpc https://api.shasta.trongrid.io
```

The test task automatically derives the Tron address from the ECDSA public key. Ensure it has sufficient TRX. Faucet: https://www.trongrid.io/faucet

To add support for additional contract types, define the parameter schema in `tasks/relayMultisigSigner/utils.ts` and add to `TronTxSchema`. Reference: https://github.com/tronprotocol/tronweb/blob/master/src/types/Contract.ts

## Hub / Oracle

### Add your hub network to the `@relay-protocol/settlement-networks` package

- First you need to add a network manifest file to the [network package](`../packages/networks/src`).
- Make sure the file has an (empty for now) `contracts` section - or it will be ignored by hardhat
- Rebuild the package `yarn workspace @relay-protocol/settlement-networks clean && yarn workspace @relay-protocol/settlement-networks build`

### Deploy the contracts

Deploy the Hub, Oracle, and (optionally) OracleMultisig with Foundry. Order
matters: deploy the hub first, then the oracle pointing at the hub, then wire
roles via `yarn grant-role` (see below).

```sh
# Deploy the hub
ADMIN=<admin-address> \
  yarn deploy:hub --rpc-url $RPC_URL --verify --etherscan-api-key $ETHERSCAN_API_KEY

# Deploy the oracle, pointing at the hub
ADMIN=<admin-address> HUB=<hub-address> \
  yarn deploy:oracle --rpc-url $RPC_URL --verify --etherscan-api-key $ETHERSCAN_API_KEY

# Optional: deploy the OracleMultisig
OWNER=<admin-address> SIGNERS=<addr1,addr2,...> THRESHOLD=<n> \
  yarn deploy:oracle-multisig --rpc-url $RPC_URL --verify

# Deploy the ERC20View helper used by the hub
yarn deploy:erc20-view --rpc-url $RPC_URL --verify
```

### Set roles

There are two main roles to set: the `ORACLE_ROLE` to allow an offchain oracle
to send data to the hub via the oracle contract, and the `EDITOR_ROLE` that
can update tokens metadata directly on the hub. Use the `grant-role` Foundry
script:

```sh
# Grant the oracle OPERATOR_ROLE on the hub (so it can mint/burn)
CONTRACT=<hub-contract> ROLE=OPERATOR_ROLE ACCOUNT=<oracle-contract> \
  yarn grant-role --rpc-url $RPC_URL

# Grant an offchain oracle signer write access to the oracle contract
CONTRACT=<oracle-contract> ROLE=ORACLE_ROLE ACCOUNT=<offchain-oracle-signer> \
  yarn grant-role --rpc-url $RPC_URL

# Grant editors write metadata access to the hub
CONTRACT=<hub-contract> ROLE=EDITOR_ROLE ACCOUNT=<editor-signer> \
  yarn grant-role --rpc-url $RPC_URL
```

`grant-role` accepts a single account; loop over multiple editors if needed.

### Submit HUB actions

1. Edit the data to send in the `calls` array of `tasks/relayMultisigSigner/scripts/generate-hub-call.ts`

2. Generate the manifest

```
bun tasks/relayMultisigSigner/scripts/generate-hub-call.ts
```

This will create a new JSON manifest.

3. Submit the multisig tx

```
# simlaute first
yarn hardhat relay-multisig-signer:simulate --transactions tasks/relayMultisigSigner/transactions/hub-calls-1.json

# submit
yarn hardhat relay-multisig-signer:submit --transactions tasks/relayMultisigSigner/transactions/hub-calls-1.json --network aurora
```

4. get all required signatures on the multitisg

```
# double check by using
yarn hardhat relay-multisig-signer:check-hashes --transactions tasks/relayMultisigSigner/transactions/hub-calls-1.json --network aurora --safe-transaction-nonce 60
```

5. Execute the signed payload

```
yarn hardhat relay-multisig-signer:execute-transactions --transactions tasks/relayMultisigSigner/transactions/hub-calls-1.json --network aurora

```

## Coverage

Tests live under `test/` and run with `forge` via `yarn test`.

Coverage reports can be generated ad-hoc:

```sh
yarn coverage    # writes out/lcov.info
```
