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

The `RelayOracle` export merges the ABIs of every historical version of the oracle and of
its successor `RelayInbox`, so a single ABI can decode both current and legacy transactions.

```typescript
import { RelayOracle, RelayOracleV2 } from "@relay-protocol/settlement-abis"

// RelayOracle covers all versions and RelayInbox, RelayOracleV2 only the deployed one
const executions = await client.getContractEvents({
  address: oracleAddress,
  abi: RelayOracle,
  eventName: "Executed",
})
```

### Pending RelayInbox deployment

`RelayOracleV2` is the ABI of the deployed oracle, so encoding `execute` /
`executeMultiple` with it keeps working. Its successor in the contract source, `RelayInbox`,
carries a signed `expiration` in `Execution`
(`Execution(bytes32 idempotencyKey,bytes[] actions,uint256 expiration)`), which changes
the `execute` / `executeMultiple` selectors, and signs under the `RelayInbox` v1 EIP-712
domain instead of `RelayOracle` v2. Use the `RelayInbox` export only against a deployed
`RelayInbox`. `RelayOracle` merges both, so decoding keeps working across the switch.
`test/oracle-exports.test.ts` pins the selectors of each export.

The exporter (`contracts/relay-chain/tools/export-abis.ts`) serves `RelayOracleV2` and
`RelayOracle` from `src/versions/index.ts` through `OVERRIDE_IMPORTS`; `RelayInbox` is the
regenerated `src/abis/RelayInbox.sol/RelayInbox.json`.

The PR that deploys `RelayInbox` must switch consumers from `RelayOracleV2` to `RelayInbox`
and update every consumer that hashes or ABI-decodes `Execution`:

- `packages/abis/src/versions/index.ts`: snapshot the deployed `RelayInbox` ABI under
  `src/versions/`, merge it into `RelayOracle`, and update
  `packages/abis/test/oracle-exports.test.ts` and this section.
- `crates/contracts-evm/abis.toml`: move the `RelayOracle` pin from commit `93b6619e`
  to the deployment commit; keep the pre-expiration build decodable by adding a
  `version = 2` entry pinned to `93b6619e` (`relay_oracle::v2::RelayOracle`). Then run
  `crates/contracts-evm/abis.sh`.
- `crates/contracts-evm/tests/oracle.rs`: pins the deployed selectors `0x32acd8f9`
  (`execute`) and `0x564df171` (`executeMultiple`) and encodes the two-field
  `Execution` tuple; switch to `0xf296a811` / `0x3d7e69fa` and the three-field tuple.
- `crates/protocol-indexer/src/chains/relay/oracle.rs`: `EXECUTION_TYPE` is the
  pre-expiration type string, `DecodedExecution` has no `expiration`, `decode_call`
  dispatches on the pinned binding's selectors, and `recover_signers` hashes
  `(typehash, idempotencyKey, actionsHash)`. Add `expiration` to the struct hash and
  the decoded execution, keep the old selectors and type string for pre-deployment
  transactions, and extend the `decodes_wrapped_executions` /
  `recovers_execution_signers` unit tests (the SDK digest fixtures in
  `contracts/relay-chain/test/RelayInbox/SdkFixture.t.sol` are usable as vectors).
- `crates/protocol-indexer/src/chains/relay/mod.rs` (`oracle_executions` rows) and
  `crates/protocol-indexer/src/database/models.rs` (`OracleExecution::recover_signers`):
  store the decoded `expiration` so signers can be recovered later; this needs a
  migration in `crates/protocol-indexer/migrations/` and refreshed `.sqlx/` query data.
- `packages/indexer/src/services/oracleExecutionProcessor.ts` decodes with the merged
  `RelayOracle` and needs no change; its test's inline ABIs stay valid.
- `contracts/relay-chain/deployments/scripts/misc/fund-pool-account.ts`: `submitExecution`
  encodes `execute` with the `RelayOracleV2` export; switch it to `RelayInbox`, and
  its `AttestationResponse.execution` type (`idempotencyKey`, `actions`, `signatures`) and the
  `execute` args it builds need the `expiration` the oracle returns.
- `packages/multisig-tools/scripts/execute-inc13-attestations.ts`: inline `oracleAbi` with
  the two-field `execute` tuple and its own `OracleExecution` type; add `expiration` to
  both or switch the ABI to the `RelayInbox` export. No other inline `Execution` ABI
  exists outside `packages/abis` and `crates/` (checked for both `parseAbi` strings and
  JSON-form `bytes[]` tuples).
- Oracle producer (the out-of-tree `oracle` service) and oracle multisig signers: carry
  executions as the SDK v2.4 `OracleExecutionMessage` (the v2.2 `ExecutionMessage` plus
  `expiration: bigint`) and sign the three-field `Execution` under the `RelayInbox` domain;
  `getOracleExecutionHash` in `packages/sdk/src/messages/v2.4/execution.ts` is the
  reference digest. The v2.2 message stays for the deployed oracle until then.

### Renamed exports

`RelayOracleV2Source`, `RelayOracleMultisig` and `RelayOracleIdempotencyStore` became
`RelayInbox`, `RelayInboxMultisig` and `RelayInboxIdempotencyStore`. The old names are
still exported as deprecated aliases, as are `IXERC20` and `IXERC20Lockbox` for the
`XERC20` and `XERC20Lockbox` ABIs of the deployed contracts. `RelayOracle` (every oracle version) and
`RelayOracleV2` (the deployed oracle) keep their names. Version 2.1.10 briefly exported
the core contracts without their `Relay` prefix (`Hub`, `Allocator`, ...); those names
are gone again, use the `Relay`-prefixed exports.

## Included ABIs

| Area              | Exports                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core              | `RelayHub`, `RelayAllocator`, `RelayExecutor`, `Config`, `ERC20View`                                                                                                                                                                       |
| Oracles           | `RelayInbox`, `RelayOracleV2`, `RelayOracle`, `RelayInboxMultisig`, `RelayInboxIdempotencyStore`, `RelayPriceOracle`                                                                                                                       |
| Price adapters    | `ChainlinkDataStreamsAdapter`, `StorkFastAdapter`, `IPriceFeedAdapter`                                                                                                                                                                     |
| Depository        | `RelayDepository`, `RelayGatewayDepository`, `ICircleGatewayWallet`, `ICircleGatewayMinter`                                                                                                                                                |
| Payload builders  | `EthereumVmPayloadBuilder`, `BitcoinVmPayloadBuilder`, `SolanaVmPayloadBuilder`, `TonVmPayloadBuilder`, `TronVmPayloadBuilder`, `XrpVmPayloadBuilder`, `HyperliquidVmPayloadBuilder`, `LighterVmPayloadBuilder`, `GatewayVmPayloadBuilder` |
| Deposit addresses | `RelayDepositAddressManager`, `SignedPricingOracle`, `BasicPricingOracle`                                                                                                                                                                  |
| Call resolvers    | `BasicCallResolver`, `PoolDrawResolver`                                                                                                                                                                                                    |
| Routers           | `Multicall3`, `MulticallRouter`, `IMulticallRouter`                                                                                                                                                                                        |
| xERC20            | `XERC20`, `XERC20Lockbox`, `XERC20Factory`                                                                                                                                                                                                 |

Interfaces (`IHub`, `ICallResolver`, `IPricingOracle`, ...) and shared libraries are also
exported. See the [TypeScript definitions](./dist/index.d.ts) for the complete list.

## Related packages

- [`@relay-protocol/settlement-sdk`](https://www.npmjs.com/package/@relay-protocol/settlement-sdk) — encoding and decoding messages for the protocol
- [`@relay-protocol/settlement-networks`](https://www.npmjs.com/package/@relay-protocol/settlement-networks) — network and contract address configuration
