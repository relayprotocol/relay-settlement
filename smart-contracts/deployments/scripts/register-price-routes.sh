#!/usr/bin/env bash
set -euo pipefail

# Registers the Chainlink Data Streams adapter on a deployed RelayPriceOracle
# and wires ETH/BTC/SOL feed routes, matching the 3 testnet streams the
# devnet Chainlink Data Streams ingester (CHAINLINK_FEED_IDS) subscribes to.
#
# Run from the smart-contracts package:
#   cd smart-contracts
#   RPC_URL=... DEPLOYER_PRIVATE_KEY=... ./deployments/scripts/register-price-routes.sh
#
# Required env:
#   - RPC_URL              – RPC endpoint of the target chain (eg. relay devnet)
#   - DEPLOYER_PRIVATE_KEY – must be the RelayPriceOracle owner
#
# Optional overrides (defaults are the relay devnet deployment, see
# deployments/hub-contracts/dev.json, and the testnet Chainlink Data Streams
# feed IDs the devnet ingester is configured with):
#   - ORACLE, ADAPTER
#   - ETH_USD_FEED, BTC_USD_FEED, SOL_USD_FEED
#   - MAX_AGE_SECONDS

ORACLE="${ORACLE}"
ADAPTER="${ADAPTER}"
PROVIDER_CHAINLINK=0x4475007f1080d802f81b754e81d29d768266942ebf41f41944a3104ba81276e6

ETH_USD_FEED="${ETH_USD_FEED:-0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782}"
BTC_USD_FEED="${BTC_USD_FEED:-0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439}"
SOL_USD_FEED="${SOL_USD_FEED:-0x0003d338ea2ac3be9e026033b1aa601673c37bab5e13851c59966f9f820754d6}"

# RelayPriceOracle keys feed routes by Hub token id, derived as
# keccak256(abi.encodePacked(chainId, currency)) (Utils.generateTokenId), so
# each (chainId, currency) pair below must exactly match the Hub token id
# convention for native currencies (SDK getVmTypeNativeCurrency/encodeAddress):
#   - Ethereum native ETH: the zero address, 20 zero bytes.
#   - Bitcoin native BTC: the sentinel address bc1qqq...mql8k8, which encodes
#     as witness version 0 + zero program, 20 zero bytes.
#   - Solana native SOL: the system program 111...111, 32 zero bytes.
NATIVE_ETH=0x0000000000000000000000000000000000000000
NATIVE_BTC=0x0000000000000000000000000000000000000000
NATIVE_SOL=0x0000000000000000000000000000000000000000000000000000000000000000

MAX_AGE_SECONDS="${MAX_AGE_SECONDS:-60}"

send_route() {
  cast send "$ORACLE" \
    "setFeedRoute((string,bytes),bytes32,bytes32,uint8,uint32)" \
    "$1" "$PROVIDER_CHAINLINK" "$2" "$3" "$MAX_AGE_SECONDS" \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
}

echo "1. Registering adapter..."
cast send "$ORACLE" \
  "setPriceFeedAdapter(bytes32,address)" \
  "$PROVIDER_CHAINLINK" "$ADAPTER" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"

echo "2. Ethereum native ETH..."
send_route "(ethereum,$NATIVE_ETH)" "$ETH_USD_FEED" 18

echo "3. Bitcoin native BTC..."
send_route "(bitcoin,$NATIVE_BTC)" "$BTC_USD_FEED" 8

echo "4. Solana native SOL..."
send_route "(solana,$NATIVE_SOL)" "$SOL_USD_FEED" 9

echo "Done."
