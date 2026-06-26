# Data Streams on-chain verification

How to verify Chainlink Data Streams reports **on-chain** by deploying
Chainlink's reference Verifier suite, and how it relates to the rest of the
Relay price oracle.

> TL;DR: the verifier is Chainlink's audited reference implementation, not
> something we write. It is built for `solc 0.8.19` with Chainlink's own
> dependency set, so it is deployed from an **isolated build** (or Chainlink's
> own tooling) rather than from our `contracts/` tree. To verify **real**
> testnet reports, the deployed `Verifier` must be configured with the DON
> signer set Chainlink uses for those feeds.

## How this fits the Relay oracle

The Chainlink Data Streams ingester (`crates/chainlink`) opens an authenticated
WebSocket and caches each feed's raw `fullReport` envelope. There are then two
ways to turn those bytes into a trusted on-chain price:

1. **Relay price precompile** (our own chains) — the precompile decodes the
   cached report and `RelayPriceOracle` reads it via a `view` call. No fee, no
   DON-signature check on-chain (verification is handled off-chain / by the
   precompile).
2. **On-chain verification** (this document) — on a public EVM chain, or any
   chain where we want the DON signatures checked in the EVM, the same
   `fullReport` bytes are passed to Chainlink's `VerifierProxy.verify(...)`,
   which checks the DON signatures and returns the decoded report. This is a
   **state-changing, fee-paying** call (LINK or native), so it cannot sit
   behind the `view` `IPricingOracle` interface unchanged.

The input to `verify()` is exactly the `fullReport` our ingester already
caches — no re-encoding needed.

## Reference implementation

The verifier is published in **`@chainlink/contracts@1.5.0`** (MIT), under
`src/v0.8/llo-feeds/`. Three generations ship in the package:

| Version | Core contracts | Notes |
| --- | --- | --- |
| **v0.3.0** | `VerifierProxy`, `Verifier`, `FeeManager`, `RewardManager` | Single-chain model used by the EVM tutorial (e.g. Arbitrum Sepolia proxy `0x2ff010DEbC1297f19579B4246cad07bd24F2488A`). **Target for this runbook.** |
| v0.4.0 | `DestinationVerifier(Proxy)`, `DestinationFeeManager`, `DestinationRewardManager` | Multi-chain "destination" model. |
| v0.5.0 | `Verifier`, `FeeManager`, `RewardManager`, `Configurator` | Latest; DON config managed by a separate `Configurator`. |

Pick v0.3.0 unless Chainlink tells us a target chain runs v0.4.0/v0.5.0 — the
generation must match whatever signs the feeds we consume.

## Deploying the verifier (outside this repo)

The reference sources are **not** vendored here — deploy them from Chainlink's
own tree, which already carries the pinned compiler and dependency set:

```sh
git clone https://github.com/smartcontractkit/chainlink
cd chainlink/contracts
# Deploy these v0.3.0 contracts with the repo's own Foundry/Hardhat toolchain:
#   src/v0.8/llo-feeds/v0.3.0/RewardManager.sol
#   src/v0.8/llo-feeds/v0.3.0/VerifierProxy.sol
#   src/v0.8/llo-feeds/v0.3.0/FeeManager.sol
#   src/v0.8/llo-feeds/v0.3.0/Verifier.sol
```

They cannot be imported into our `solc 0.8.28` build, which is why they stay
out of `contracts/`:

- every file pins `pragma solidity 0.8.19;` (exact, not `^0.8`);
- they pull **five aliased OpenZeppelin versions**
  (`@openzeppelin/contracts@4.7.3 … 5.1.0`),
  `@openzeppelin/contracts-upgradeable@4.9.6`, Chainlink's vendored `shared/`
  contracts, and a vendored `forge-std`;
- the `@chainlink/contracts` npm package ships **ABI only — no bytecode**.

This repo keeps only the Relay-side consumer (the adapter, below) and this
runbook; the verifier deployment lives in Chainlink's repo/toolchain.

## Relay-side consumer: the price adapter

`ChainlinkDataStreamsAdapter` (`contracts/price-adapters/`) is the Relay side of
this. On chains running the Relay price precompile, `RelayPriceOracle` hands the
adapter the raw `fullReport` and it decodes the V3 report into
`(usdPrice, 18 decimals, observationsTimestamp)` with structural checks (schema,
feed-id binding, positive price, not-expired). It does **not** check DON
signatures on-chain — that is the `VerifierProxy.verify` path above, for chains
without the precompile. There, the same `fullReport` bytes are passed to
`verify` first; the verified report can then be decoded the same way.

## Deployment sequence

Constructors and wiring (verify against the pinned v0.3.0 sources before
running — argument lists are reproduced here for convenience):

```
1. RewardManager(linkAddress)
2. VerifierProxy(accessController)                 // address(0) = open access
3. FeeManager(linkAddress, nativeAddress, verifierProxy, rewardManager)
4. rewardManager.setFeeManager(feeManager)
5. verifierProxy.setFeeManager(feeManager)
6. Verifier(verifierProxy)
7. verifierProxy.initializeVerifier(verifier)
8. verifier.setConfig(
       feedId,
       signers,                    // DON signer addresses (see below)
       offchainTransmitters,
       f,                          // fault tolerance; signers.length >= 3f+1
       onchainConfig,
       offchainConfigVersion,
       offchainConfig,
       recipientAddressesAndWeights
   )                               // computes the configDigest, registers it
                                   // in the proxy via setVerifier
```

Verification call (consumer side):

```solidity
// payload         = the cached fullReport bytes
// parameterPayload = abi.encode(feeTokenAddress)  // LINK or native
bytes memory verified = verifierProxy.verify{value: nativeFee}(payload, parameterPayload);
```

When paying in LINK, approve the `RewardManager` for the fee returned by
`FeeManager.getFeeAndReward(...)` before calling `verify`.

## DON configuration — the crux

A `Verifier` only accepts reports whose **config digest** (carried in
`reportContext[0]`) matches a config it has registered via `setConfig`. The
digest is derived from `(feedId, signers, f, onchainConfig,
offchainConfigVersion, offchainConfig, ...)`.

- **To verify real Data Streams testnet reports**, `setConfig` must be called
  with the **exact** parameters Chainlink uses for those feeds, so the derived
  digest equals the one in the reports. Obtain these from Chainlink, or read
  them from the `ConfigSet` event of the canonical testnet verifier. Any
  mismatch ⇒ `verify` reverts.
- **For integration testing without Chainlink**, configure a signer set we
  control and self-sign reports (the `crates/chainlink` decoder already builds
  V3 report envelopes; signing would be added there). This exercises the full
  `verify` + fee path independently of the real DON.

This is why production verifiers are deployed and configured by Chainlink: they
own the DON signer set.

## Fees on a Relay testnet

`verify` routes a fee through `FeeManager` → `RewardManager`. For a testnet you
can:

- deploy a mock LINK (and set a `nativeAddress`), and/or
- register a zero-fee config so `getFeeAndReward` returns `0` while wiring is
  validated.

Mainnet/real-feed fees are non-zero and paid in LINK or the chain's native
token.

## Open items / blockers

- [ ] **DON config from Chainlink** for the target testnet feeds (signer set,
      `f`, `feedId`, config version, on/offchain config) — required before real
      reports verify. Tracked under DEC-1152.
- [ ] Confirm with Chainlink which verifier **generation** (v0.3.0 / v0.4.0 /
      v0.5.0) signs the Relay testnet feeds.
- [ ] Decide whether Relay operates its own verifier instance on the Relay
      testnet or consumes a Chainlink-operated deployment.

## References

- Tutorial: <https://docs.chain.link/data-streams/tutorials/evm-onchain-report-verification>
- On-chain verification reference: <https://docs.chain.link/data-streams/reference/data-streams-api/onchain-verification>
- Reference contracts: `@chainlink/contracts@1.5.0`,
  `src/v0.8/llo-feeds/v0.3.0/` (`smartcontractkit/chainlink`)
