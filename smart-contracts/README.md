# Relay Protocol

## Allocator

Deploy, set up and use the allocator. Multiple tasks exist to set things up:

```sh
# Deploy the main Allocator contract
# (will deploy 3 libraires + 1 contract Allocator)
yarn hardhat deploy:allocator --owner <multisig-address> --delay 1

# deploy the EVM payload builder (you can deploy other types as well)
yarn run hardhat ignition deploy ignition/modules/EVMPayloadBuilder.ts

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

We have deployed an instance of this contract on Aurora at `0x66667945C34b399993cA834587886b8508dB39B1`.

### Example of flow:

Pre-requisite: add a `SAFE_API_KEY` env variable!

1. A transactions manifest file is created. It represents the transaction(s) to be executed on each chain. This file should be created from a script (it's format is validated when loaded by the scripts below).
2. It is possible to simulate all the transactions using `relay-multisig-signer:simulate --transactions <manifest.json>`
3. The hashes for each transaction are generated and submitted to the SAFE multisig using the task `relay-multisig-signer:submit --transactions <manifest.json> --relay-multisig-signer <multisig signer address>`
4. The signers on the multisig can verify that the SAFE transaction they are signing is correct by running `relay-multisig-signer:check-hashes --transactions <manifest.json> --relay-multisig-signer <multisig signer address> --safe-transaction-nonce <transaction number>`. If they match they can sign (approve the multisig tx).
5. Once the SAFE transaction has been executed, anyone can execute all the transactions from the bundle using
   `relay-multisig-signer:execute-transactions --transactions <manifest.json> --relay-multisig-signer <multisig signer address> --safe-transaction-nonce <transaction number>`
