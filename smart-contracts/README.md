# Relay Protocol

## Allocator

Deploy, set up and use the allocator. Multiple tasks exist to set things up:

```sh
# Deploy the main Allocator contract
# (will deploy 3 libraires + 1 contract Allocator)
yarn hardhat deploy:allocator --owner <multisig-address> --delay 1

# verfy contracts
yarn hardhat ignition verify chain-1313161555

# deploy the EVM payload builder (you can deploy other types as well)
yarn run hardhat ignition deploy ignition/modules/EVMPayloadBuilder.ts

# set dummy payload builder in allocator
yarn hardhat allocator:set-payload-builder --builder <builder-address> --allocator <allocator-contract-address> --chain-id <depository-contract-chain> --depository <depository-contract-address>

# grant APPROVED_WITHDRAWER_ROLE to your address
yarn hardhat allocator:allocator:add-withdrawer --allocator <allocator-contract-address>

# submit withdraw request params (thru block explorer)
yarn hardhat allocator:submit-withdraw --allocator <allocator-address> --chain-id <depository-chain-id> --depository <depository-contract-address>

# sign payload
yarn hardhat allocator:sign-payload --payload-id <payload-id> --allocator <allocator-address>

# submit the withdrawal to the depository contract (passing the payload builder enables formatting of the transaction)
yarn hardhat depository:withdraw --payload-id <payload-id> --allocator <allocator-address> --payload-builder-type <payload-builder-name>

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

Replace `<account-name>` with a unique account name in the following commands

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
