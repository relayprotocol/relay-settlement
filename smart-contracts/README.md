# Relay Protocol

## Allocator

Deploy, set up and use the allocator

```sh
# Deploy the main Allocator contract
# (will deploy 3 libraires + 1 contract Allocator)
yarn hardhat deploy:allocator --owner <multisig-address> --delay 1

# verfy contracts
yarn hardhat ignition verify chain-1313161555

# deploy the payload builder
yarn hardhat deploy:payload-builder --payload-builder DummyPayloadBuilder

# set dummy payload builder in allocator
yarn hardhat allocator:set-payload-builder --builder <builder-address> --allocator <allocator-contract-address> --chain-id 1 --escrow <escrow-contract-address> --network aurora-testnet

# grant HUB_ROLE to your address
yarn hardhat allocator:hub-role --allocator <allocator-contract-address>

# submit withdraw request params (thru block explorer)
yarn hardhat allocator:submit-withdraw --allocator <allocator-address> --chain-id <escrow-chain-id> --escrow <escrow-contract-address>

# sign payload
yarn hardhat allocator:sign-payload --id <payload-id> --allocator <allocator-address>
```
