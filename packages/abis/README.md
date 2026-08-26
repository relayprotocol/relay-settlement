# Relay Settlement Contract ABIs

Contract ABIs for the Relay Settlement Protocol, published as plain JSON ABI arrays.

## Installation

```bash
npm install @relay-protocol/settlement-abis
# or
yarn add @relay-protocol/settlement-abis
```

## Usage

Every export is a plain ABI array, so it can be passed directly to viem, ethers, or any
other library that accepts a JSON ABI.

### Reading contract state

```typescript
import { RelayHub } from "@relay-protocol/settlement-abis"
import { createPublicClient, http } from "viem"

const client = createPublicClient({ transport: http("https://...") })

const balance = await client.readContract({
  address: hubAddress,
  abi: RelayHub,
  functionName: "balanceOf",
  args: [account, tokenId],
})
```

### Decoding events

```typescript
import { RelayHub } from "@relay-protocol/settlement-abis"

const transfers = await client.getContractEvents({
  address: hubAddress,
  abi: RelayHub,
  eventName: "Transfer",
})
```

### Decoding historical transactions

The `RelayOracle` export merges the ABIs of every historical version of the oracle, so a
single ABI can decode both current and legacy transactions.

```typescript
import { RelayOracle, RelayOracleV2 } from "@relay-protocol/settlement-abis"

// RelayOracle covers all deployed versions, RelayOracleV2 only the current one
const executions = await client.getContractEvents({
  address: oracleAddress,
  abi: RelayOracle,
  eventName: "Executed",
})
```

## Included ABIs

| Area              | Exports                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core              | `RelayHub`, `RelayAllocator`, `RelayExecutor`, `Config`, `ERC20View`, `WithdrawGasPayer`                                                                                                                                                   |
| Oracles           | `RelayOracleV2`, `RelayOracle`, `RelayOracleMultisig`, `RelayOracleIdempotencyStore`, `RelayPriceOracle`                                                                                                                                   |
| Price adapters    | `ChainlinkDataStreamsAdapter`, `StorkFastAdapter`, `IPriceFeedAdapter`                                                                                                                                                                     |
| Depository        | `RelayDepository`, `RelayGatewayDepository`, `ICircleGatewayWallet`, `ICircleGatewayMinter`                                                                                                                                                |
| Payload builders  | `EthereumVmPayloadBuilder`, `BitcoinVmPayloadBuilder`, `SolanaVmPayloadBuilder`, `TonVmPayloadBuilder`, `TronVmPayloadBuilder`, `XrpVmPayloadBuilder`, `HyperliquidVmPayloadBuilder`, `LighterVmPayloadBuilder`, `GatewayVmPayloadBuilder` |
| Deposit addresses | `RelayDepositAddressManager`, `SignedPricingOracle`, `BasicPricingOracle`                                                                                                                                                                  |
| Call resolvers    | `BasicCallResolver`, `PoolDrawResolver`                                                                                                                                                                                                    |
| Routers           | `MulticallRouter`, `IMulticallRouter`                                                                                                                                                                                                      |

Interfaces (`IHub`, `ICallResolver`, `IPricingOracle`, ...) and shared libraries are also
exported. See the [TypeScript definitions](./dist/index.d.ts) for the complete list.

## Related packages

- [`@relay-protocol/settlement-sdk`](https://www.npmjs.com/package/@relay-protocol/settlement-sdk) — encoding and decoding messages for the protocol
- [`@relay-protocol/settlement-networks`](https://www.npmjs.com/package/@relay-protocol/settlement-networks) — network and contract address configuration
