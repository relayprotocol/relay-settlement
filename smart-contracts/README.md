# Relay Protocol

## Allocator

Deploy, set up and use the allocator. Multiple tasks exist to set things up:

```sh
# Deploy the main RelayAllocator contract
yarn hardhat deploy:allocator --owner <multisig-address> --hub <relay-hub-address>

# deploy the Config contract for the allocator
yarn hardhat deploy:allocator-config --allocator <allocator-contract-address>

# deploy the EVM payload builder
yarn hardhat deploy:ethereum-vm-payload-builder --config-address <config-contract-address>

# deploy the Solana VM payload builder
yarn hardhat deploy:solana-vm-payload-builder --config-address <config-contract-address>

# alternatively, you can deploy the raw ignition modules directly
yarn run hardhat ignition deploy ignition/modules/EthereumVmPayloadBuilder.ts

# verify contracts
yarn hardhat ignition verify chain-1313161555

# grant APPROVED_WITHDRAWER_ROLE to your address
yarn hardhat allocator:add-withdrawer --allocator <allocator-contract-address>

# set dummy payload builder in allocator
yarn hardhat allocator:set-payload-builder --builder <builder-address> --allocator <allocator-contract-address> --chain-id <depository-contract-chain> --depository <depository-contract-address>

# submit withdraw request params (thru block explorer)
yarn hardhat allocator:submit-withdraw --allocator <allocator-address> --chain-id <depository-chain-id> --depository <depository-contract-address>

# sign payload
yarn hardhat allocator:sign-payload --allocator <allocator-address> --chain-id <depository-chain-id> --depository <depository-contract-address> --nonce <nonce from withdraw request>

# submit the withdrawal to the depository contract (passing the payload builder enables formatting of the transaction)
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

You can now deploy the Hub and Oracle contracts on your new chain.

```sh
yarn hardhat hub:setup --network <hub-network>
```

NB: This will also configure correctly the oracle as `OPERATOR_ROLE` of the hub, and set the deployer address as `ORACLE_ROLE` for testing purposes - you may want to revoke that later.

### Test perms on the oracle

```sh
yarn hardhat test-oracle --network <hub-network> --oracle <hub-network>
```

WARN: This will write and tweak balances of accounts on the hub

### Set roles

There is two main roles to set: the `ORACLE_ROLE` to allow an offchain oracle to send data to the hub via the oracle contract, and the `EDITOR_ROLE` that can update tokens metadata directly on the hub.

```sh
# grant offchain oracle signer write access to the oracle contract
yarn hardhat grant-role --contract <oracle-contract> --account <offchain-oracle-signer> --role ORACLE_ROLE --network <hub-network>

# grant editors write metadata access to the hub
yarn hardhat grant-role --contract <hub-contract> --accounts <list-of-signers> --role EDITOR_ROLE --network <hub-network>
```

NB: we pass a list of editors addresses to the hub to support multi-EOA

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

The contracts are currently being migrated from Hardhat to Foundry (see DEC-905). During the dual-run window, tests for ported modules live under `test-foundry/` and run with `forge`, while tests for un-ported modules live under `test/` and run with `hardhat`. A combined coverage gate enforces that no `(file, line)` or branch hit in the baseline is ever lost — regardless of which toolchain is producing the hits.

```sh
# produce Hardhat coverage at coverage/lcov.info
yarn coverage

# produce Foundry coverage at forge-out/lcov.info
yarn forge:coverage

# combine + compare against the committed baseline; exits non-zero on regression
yarn coverage:diff:combined coverage-baseline/hardhat.lcov

# convenience: run everything in one shot
yarn coverage:gate
```

The baseline lives at `coverage-baseline/hardhat.lcov`. It was generated from the original Hardhat suite at the start of the migration. `yarn coverage:diff:combined` unions the per-file line/branch hit counts from `coverage/lcov.info` and `forge-out/lcov.info` into `coverage/combined.lcov`, then calls `coverage-diff` against the baseline.

Behavior notes:

- `coverage-diff` reports any `(file, line)` or branch hit in the baseline that is no longer hit in either current run.
- Omit the baseline argument to disable the gate explicitly (script logs and exits 0). This is the safe wiring while no baseline has been committed.
- A baseline argument that points to a missing file is treated as a configuration error (exit 2), so typos and broken CI wiring fail loud.
- LCOV `SF:` paths are normalized to repo-relative `contracts/...` form before comparison so baselines generated on a different machine still line up.
- If the baseline references files that don't exist on disk, the script aborts loudly rather than silently reporting "no regressions".

When intentionally regenerating the baseline (for example after removing dead contract code, or rebasing the baseline onto Foundry-only coverage at the end of the migration), include the literal token `[baseline:refresh]` in the HEAD commit message. The diff script honors this tag and skips the gate so the baseline can be updated in the same PR.
