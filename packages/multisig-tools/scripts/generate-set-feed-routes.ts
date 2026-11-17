// Generate a manifest adding the reviewed Stork currency routes through
// RelayMultisigSigner. Existing matching routes are skipped and conflicting
// routes are rejected. Calls are batched against the target env's oracle.
// This only writes a manifest; multisig approval and execution are separate.
// Confirm the referenced Stork streams are live before using the new routes.
//
// Env:
//   ENV      deployment env to target (dev | stag | prod). Required.
//   RPC_URL  optional target-chain RPC override.
//   START_NONCE optional starting nonce after earlier queued owner transactions.
//   SIGNER   optional 0x signer address to use as `from`. When set, the
//            NEAR/MPC derivation is skipped. The address must match the
//            deployed oracle's current owner.
//   ALLOW_UNSERVED_FEEDS optional comma-separated Stork symbols that may be
//            routed before the sequencer serves them (for example
//            `CASHUSD,DAIUSD`). Every other feed must already answer on the
//            price-oracle precompile or generation fails.
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import {
  concat,
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  type Hex,
} from "viem"
import { encodeAddressToHex, type VmType } from "@relay-protocol/settlement-sdk"
import {
  relay as relayChain,
  relayTestnet,
  aurora,
} from "@relay-protocol/settlement-networks"
import { RelayPriceOracle } from "@relay-protocol/settlement-abis"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

export type Env = "dev" | "stag" | "prod"

export const parseEnv = (value: string | undefined): Env => {
  if (!value || !["dev", "stag", "prod"].includes(value)) {
    throw new Error(`ENV must be one of dev | stag | prod, got "${value}"`)
  }
  return value as Env
}

export const STORK_PROVIDER_ID = keccak256(new TextEncoder().encode("stork"))
export const STORK_TAXONOMY_ID = 1
export const STORK_FEEDS = {
  AVAXUSD: 10,
  BERAUSD: 310,
  BNBUSD: 12,
  BTCUSD: 3,
  CASHUSD: 422,
  CROUSD: 13,
  DAIUSD: 423,
  ETHUSD: 4,
  HYPEUSD: 19,
  MNTUSD: 23,
  MONUSD: 406,
  MUSDUSD: 424,
  PATHUSDUSD: 425,
  POLYMARKETUSDUSD: 426,
  PYUSDUSD: 427,
  SOLUSD: 40,
  SUSD: 340,
  TONUSD: 30,
  TRXUSD: 32,
  USDCEUSD_CRONOS: 428,
  USDCEUSD_POLYGON: 429,
  USDCUSD: 2,
  USDGUSD: 430,
  USDMUSD: 431,
  USDTUSD: 1,
  XPLUSD: 347,
  XRPUSD: 38,
} as const

export type StorkFeed = keyof typeof STORK_FEEDS

/// Stork fast feed ids are keccak256(uint16 taxonomyId, uint16 assetId),
/// matching `fast_feed_id` in crates/stork-ingester/src/taxonomy.rs.
export const storkFeedId = (feed: StorkFeed): Hex =>
  keccak256(
    encodePacked(["uint16", "uint16"], [STORK_TAXONOMY_ID, STORK_FEEDS[feed]])
  )

/// Address the price-oracle precompile registers at in the rollup. A
/// staticcall with `providerId ++ feedId` returns the latest signed update, or
/// fails when the sequencer does not serve that feed.
export const PRICE_ORACLE_PRECOMPILE: Hex =
  "0x0000000000000000000000000000000000010002"

export const ROUTE_BATCH_SIZE = 32

export type FeedRoute = {
  feed: StorkFeed
  label: string
  currency: { chainId: string; currency: `0x${string}` }
  providerId: `0x${string}`
  feedId: `0x${string}`
  currencyDecimals: number
  maxAgeSeconds: number
}

// Pinned from https://api.relay.link/chains on 2026-09-15; the stablecoin
// routes (CASH, DAI, mUSD, PathUSD, pUSD, PYUSD, USDG, USDm) and the
// chain-specific Cronos and Polygon USDC.e feeds were added on 2026-10-21
// from the same endpoint, after Stork published those streams on 2026-09-29.
// WETH and bridged representations use the underlying asset USD price.
// USDT0 addresses checked against https://usdt0.to/ecosystem and
// https://github.com/Everdawn-Labs/usdt0-audit-reports/blob/main/DEPLOYMENTS.md.
// USDT0 representations price through USDTUSD: Stork has no USDT0USD stream
// (asset id 362 is not in the taxonomy), so the Sovereign ingester does not serve it.
// PENGU and Plume USDC are excluded by the solver acceptance rules.
// Native AVAX, BERA, MNT and S are included for gas-token pricing.
// Only additions: the eleven existing routes are intentionally omitted.
// Tuple: protocol chain id, label, VM, source address, token decimals, USD feed.
export const currencies: [string, string, VmType, string, number, StorkFeed][] =
  [
    [
      "abstract",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "abstract",
      "USDC",
      "ethereum-vm",
      "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1",
      6,
      "USDCUSD",
    ],
    [
      "arbitrum",
      "USDT",
      "ethereum-vm",
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      6,
      "USDTUSD",
    ],
    [
      "arbitrum",
      "WETH",
      "ethereum-vm",
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      18,
      "ETHUSD",
    ],
    [
      "avalanche",
      "AVAX",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "AVAXUSD",
    ],
    [
      "avalanche",
      "USDC",
      "ethereum-vm",
      "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      6,
      "USDCUSD",
    ],
    [
      "base",
      "cbBTC",
      "ethereum-vm",
      "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      8,
      "BTCUSD",
    ],
    [
      "base",
      "SOL",
      "ethereum-vm",
      "0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82",
      9,
      "SOLUSD",
    ],
    [
      "base",
      "USDT",
      "ethereum-vm",
      "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      6,
      "USDTUSD",
    ],
    [
      "base",
      "WETH",
      "ethereum-vm",
      "0x4200000000000000000000000000000000000006",
      18,
      "ETHUSD",
    ],
    [
      "berachain",
      "BERA",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "BERAUSD",
    ],
    [
      "berachain",
      "USDC",
      "ethereum-vm",
      "0x549943e04f40284185054145c6E4e9568C1D3241",
      6,
      "USDCUSD",
    ],
    [
      "berachain",
      "WETH",
      "ethereum-vm",
      "0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590",
      18,
      "ETHUSD",
    ],
    [
      "bnb",
      "BNB",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "BNBUSD",
    ],
    [
      "bnb",
      "USDC",
      "ethereum-vm",
      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      18,
      "USDCUSD",
    ],
    [
      "bnb",
      "USDT",
      "ethereum-vm",
      "0x55d398326f99059fF775485246999027B3197955",
      18,
      "USDTUSD",
    ],
    [
      "bob",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "boba",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "celo",
      "USDC",
      "ethereum-vm",
      "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      6,
      "USDCUSD",
    ],
    [
      "cronos",
      "CRO",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "CROUSD",
    ],
    [
      "cronos",
      "USDC",
      "ethereum-vm",
      "0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D",
      6,
      "USDCUSD",
    ],
    [
      "cronos",
      "USDC.e",
      "ethereum-vm",
      "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59",
      6,
      "USDCEUSD_CRONOS",
    ],
    [
      "doma",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "doma",
      "USDC.e",
      "ethereum-vm",
      "0x31EEf89D5215C305304a2fA5376a1f1b6C5dc477",
      6,
      "USDCUSD",
    ],
    [
      "eclipse",
      "ETH",
      "solana-vm",
      "11111111111111111111111111111111",
      9,
      "ETHUSD",
    ],
    [
      "ethereum",
      "WETH",
      "ethereum-vm",
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      18,
      "ETHUSD",
    ],
    [
      "ethereum",
      "DAI",
      "ethereum-vm",
      "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      18,
      "DAIUSD",
    ],
    [
      "ethereum",
      "mUSD",
      "ethereum-vm",
      "0xacA92E438df0B2401fF60dA7E4337B687a2435DA",
      6,
      "MUSDUSD",
    ],
    [
      "ethereum",
      "PYUSD",
      "ethereum-vm",
      "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
      6,
      "PYUSDUSD",
    ],
    [
      "ethereum",
      "USDG",
      "ethereum-vm",
      "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
      6,
      "USDGUSD",
    ],
    [
      "ethereum",
      "USDm",
      "ethereum-vm",
      "0xEc2AF1C8B110a61fD9C3Fa6a554a031Ca9943926",
      18,
      "USDMUSD",
    ],
    [
      "flow",
      "USDC",
      "ethereum-vm",
      "0xF1815bd50389c46847f0Bda824eC8da914045D14",
      6,
      "USDCUSD",
    ],
    [
      "gensyn",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "gensyn",
      "USDC",
      "ethereum-vm",
      "0x5b32c997211621d55a89Cc5abAF1cC21F3A6ddF5",
      6,
      "USDCUSD",
    ],
    [
      "gnosis",
      "USDC",
      "ethereum-vm",
      "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0",
      6,
      "USDCUSD",
    ],
    [
      "hyperevm",
      "HYPE",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "HYPEUSD",
    ],
    [
      "hyperevm",
      "USD₮0",
      "ethereum-vm",
      "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
      6,
      "USDTUSD",
    ],
    [
      "hyperevm",
      "USDC",
      "ethereum-vm",
      "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
      6,
      "USDCUSD",
    ],
    [
      "hyperliquid",
      "USDC",
      "hyperliquid-vm",
      "0x00000000000000000000000000000000",
      8,
      "USDCUSD",
    ],
    [
      "ink",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "ink",
      "USDC",
      "ethereum-vm",
      "0x2D270e6886d130D724215A266106e6832161EAEd",
      6,
      "USDCUSD",
    ],
    [
      "ink",
      "USDT0",
      "ethereum-vm",
      "0x0200C29006150606B650577BBE7B6248F58470c1",
      6,
      "USDTUSD",
    ],
    [
      "katana",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "katana",
      "USDC",
      "ethereum-vm",
      "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36",
      6,
      "USDCUSD",
    ],
    [
      "katana",
      "USDT",
      "ethereum-vm",
      "0x2DCa96907fde857dd3D816880A0df407eeB2D2F2",
      6,
      "USDTUSD",
    ],
    ["lighter", "ETH (Spot)", "lighter-vm", "1", 8, "ETHUSD"],
    ["lighter", "USDC (Perp)", "lighter-vm", "0", 6, "USDCUSD"],
    ["lighter", "USDC (Spot)", "lighter-vm", "3", 6, "USDCUSD"],
    [
      "linea",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "linea",
      "USDC",
      "ethereum-vm",
      "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
      6,
      "USDCUSD",
    ],
    [
      "linea",
      "mUSD",
      "ethereum-vm",
      "0xacA92E438df0B2401fF60dA7E4337B687a2435DA",
      6,
      "MUSDUSD",
    ],
    [
      "manta",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "mantle",
      "MNT",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "MNTUSD",
    ],
    [
      "mantle",
      "USDC",
      "ethereum-vm",
      "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
      6,
      "USDCUSD",
    ],
    [
      "megaeth",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "megaeth",
      "USDT",
      "ethereum-vm",
      "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
      6,
      "USDTUSD",
    ],
    [
      "megaeth",
      "USDm",
      "ethereum-vm",
      "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7",
      18,
      "USDMUSD",
    ],
    [
      "metis",
      "WETH",
      "ethereum-vm",
      "0x420000000000000000000000000000000000000A",
      18,
      "ETHUSD",
    ],
    [
      "mode",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "monad",
      "MON",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "MONUSD",
    ],
    [
      "monad",
      "USDC",
      "ethereum-vm",
      "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      6,
      "USDCUSD",
    ],
    [
      "monad",
      "mUSD",
      "ethereum-vm",
      "0xacA92E438df0B2401fF60dA7E4337B687a2435DA",
      6,
      "MUSDUSD",
    ],
    [
      "morph",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "mythos",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "mythos",
      "USDC.e",
      "ethereum-vm",
      "0x0685B38c8228f595688dEc1D7C69d036b3Ee52d7",
      6,
      "USDCUSD",
    ],
    [
      "optimism",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "optimism",
      "USDC",
      "ethereum-vm",
      "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      6,
      "USDCUSD",
    ],
    [
      "optimism",
      "USDT",
      "ethereum-vm",
      "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      6,
      "USDTUSD",
    ],
    [
      "optimism",
      "WETH",
      "ethereum-vm",
      "0x4200000000000000000000000000000000000006",
      18,
      "ETHUSD",
    ],
    [
      "plasma",
      "USD₮0",
      "ethereum-vm",
      "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
      6,
      "USDTUSD",
    ],
    [
      "plasma",
      "XPL",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "XPLUSD",
    ],
    [
      "plume",
      "WETH",
      "ethereum-vm",
      "0xca59cA09E5602fAe8B629DeE83FfA819741f14be",
      18,
      "ETHUSD",
    ],
    [
      "polygon",
      "USDC",
      "ethereum-vm",
      "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      6,
      "USDCUSD",
    ],
    [
      "polygon",
      "USDC.e",
      "ethereum-vm",
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      6,
      "USDCEUSD_POLYGON",
    ],
    [
      "polygon",
      "USDT",
      "ethereum-vm",
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      6,
      "USDTUSD",
    ],
    [
      "polygon",
      "pUSD",
      "ethereum-vm",
      "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
      6,
      "POLYMARKETUSDUSD",
    ],
    [
      "robinhood",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "robinhood",
      "USDG",
      "ethereum-vm",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      6,
      "USDGUSD",
    ],
    ["robinhood-lighter", "USDG", "lighter-vm", "0", 6, "USDGUSD"],
    [
      "ronin",
      "USDC",
      "ethereum-vm",
      "0x0B7007c13325C48911F73A2daD5FA5dCBf808aDc",
      6,
      "USDCUSD",
    ],
    [
      "scroll",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "shape",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "solana",
      "USDC",
      "solana-vm",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      6,
      "USDCUSD",
    ],
    [
      "solana",
      "USDT",
      "solana-vm",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      6,
      "USDTUSD",
    ],
    [
      "solana",
      "CASH",
      "solana-vm",
      "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
      6,
      "CASHUSD",
    ],
    [
      "solana",
      "PYUSD",
      "solana-vm",
      "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      6,
      "PYUSDUSD",
    ],
    [
      "solana",
      "USDG",
      "solana-vm",
      "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
      6,
      "USDGUSD",
    ],
    [
      "soneium",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "soneium",
      "USDC.e",
      "ethereum-vm",
      "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369",
      6,
      "USDCUSD",
    ],
    [
      "sonic",
      "S",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "SUSD",
    ],
    [
      "sonic",
      "USDC",
      "ethereum-vm",
      "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
      6,
      "USDCUSD",
    ],
    [
      "stable",
      "USDT0",
      "ethereum-vm",
      "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      6,
      "USDTUSD",
    ],
    [
      "tempo",
      "USDC",
      "ethereum-vm",
      "0x20C000000000000000000000b9537d11c60E8b50",
      6,
      "USDCUSD",
    ],
    [
      "tempo",
      "USDT0",
      "ethereum-vm",
      "0x20C00000000000000000000014f22CA97301EB73",
      6,
      "USDTUSD",
    ],
    [
      "tempo",
      "PathUSD",
      "ethereum-vm",
      "0x20C0000000000000000000000000000000000000",
      6,
      "PATHUSDUSD",
    ],
    [
      "tron",
      "USDT",
      "tron-vm",
      "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      6,
      "USDTUSD",
    ],
    [
      "unichain",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "unichain",
      "USDC",
      "ethereum-vm",
      "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
      6,
      "USDCUSD",
    ],
    [
      "worldchain",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "worldchain",
      "USDC",
      "ethereum-vm",
      "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
      6,
      "USDCUSD",
    ],
    [
      "xlayer",
      "USDC",
      "ethereum-vm",
      "0xB6CEceAB302E2E4948951eE7843FC24E92933061",
      6,
      "USDCUSD",
    ],
    [
      "xlayer",
      "USDG",
      "ethereum-vm",
      "0x4ae46a509F6b1D9056937BA4500cb143933D2dc8",
      6,
      "USDGUSD",
    ],
    ["xrp", "XRP", "xrp-vm", "rrrrrrrrrrrrrrrrrrrrrhoLvTp", 6, "XRPUSD"],
    [
      "zircuit",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "zksync",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "zora",
      "ETH",
      "ethereum-vm",
      "0x0000000000000000000000000000000000000000",
      18,
      "ETHUSD",
    ],
    [
      "zora",
      "USDzC",
      "ethereum-vm",
      "0xCccCCccc7021b32EBb4e8C08314bD62F7c653EC4",
      6,
      "USDCUSD",
    ],
  ]

export const storkPriceRoutes: FeedRoute[] = currencies.map(
  ([chainId, symbol, vmType, address, currencyDecimals, feed]) => ({
    currency: { chainId, currency: encodeAddressToHex(address, vmType) },
    currencyDecimals,
    feed,
    feedId: storkFeedId(feed),
    label: `${chainId}-${symbol}`,
    maxAgeSeconds: 30,
    providerId: STORK_PROVIDER_ID,
  })
)

export const routeTokenId = (route: FeedRoute): bigint =>
  BigInt(
    keccak256(
      encodePacked(
        ["string", "bytes"],
        [route.currency.chainId, route.currency.currency]
      )
    )
  )

export type CurrentRoute = readonly [string, string, number, number, boolean]

/** Skip matching routes; reject conflicts instead of replacing owner configuration. */
export function selectMissingRoutes(
  routes: FeedRoute[],
  current: CurrentRoute[]
): FeedRoute[] {
  if (routes.length !== current.length)
    throw new Error("Route result count mismatch")
  const seen = new Set<bigint>()
  return routes.filter((route, index) => {
    const tokenId = routeTokenId(route)
    if (seen.has(tokenId))
      throw new Error(`Duplicate currency route: ${route.label}`)
    seen.add(tokenId)
    const [providerId, feedId, decimals, maxAge, exists] = current[index]
    if (!exists) return true
    if (
      providerId.toLowerCase() !== route.providerId.toLowerCase() ||
      feedId.toLowerCase() !== route.feedId.toLowerCase() ||
      decimals !== route.currencyDecimals ||
      maxAge !== route.maxAgeSeconds
    ) {
      throw new Error(`Conflicting existing route: ${route.label}`)
    }
    return false
  })
}

/** Split routes into bounded `setFeedRoutes` batches with contiguous nonces. */
export function batchRoutes(
  routes: FeedRoute[],
  startNonce: number,
  batchSize = ROUTE_BATCH_SIZE
): { nonce: number; routes: FeedRoute[] }[] {
  const batches: { nonce: number; routes: FeedRoute[] }[] = []
  for (let index = 0; index < routes.length; index += batchSize) {
    batches.push({
      nonce: startNonce + batches.length,
      routes: routes.slice(index, index + batchSize),
    })
  }
  return batches
}

export const parseAllowedUnservedFeeds = (
  value: string | undefined
): Set<StorkFeed> => {
  const allowed = new Set<StorkFeed>()
  for (const symbol of (value ?? "").split(",")) {
    const trimmed = symbol.trim()
    if (!trimmed) continue
    if (!(trimmed in STORK_FEEDS)) {
      throw new Error(`ALLOW_UNSERVED_FEEDS: unknown Stork feed "${trimmed}"`)
    }
    allowed.add(trimmed as StorkFeed)
  }
  return allowed
}

/**
 * Partition the distinct feeds behind `routes` by whether the sequencer serves
 * them. Unserved feeds outside `allowed` are an error: their routes would make
 * `resolveUsdPrice` revert with `PriceFeedCallFailed` after execution.
 */
export function checkServedFeeds(
  routes: FeedRoute[],
  servedFeeds: ReadonlySet<StorkFeed>,
  allowed: ReadonlySet<StorkFeed>
): { served: StorkFeed[]; unserved: StorkFeed[] } {
  const feeds = [...new Set(routes.map((route) => route.feed))].sort()
  const served = feeds.filter((feed) => servedFeeds.has(feed))
  const unserved = feeds.filter((feed) => !servedFeeds.has(feed))
  const blocked = unserved.filter((feed) => !allowed.has(feed))
  if (blocked.length) {
    throw new Error(
      `Stork feeds not served by the sequencer: ${blocked.join(", ")}. ` +
        "Ask Sovereign to add them to the ingester, or set " +
        "ALLOW_UNSERVED_FEEDS to route them ahead of ingestion."
    )
  }
  return { served, unserved }
}

const main = async () => {
  const ENV = parseEnv(process.env.ENV)
  const deployment = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../contracts/relay-chain/deployments/contracts/${ENV}.json`
      ),
      "utf8"
    )
  ) as { pricingOracle: { priceOracle: string } }
  const priceOracle = deployment.pricingOracle.priceOracle as `0x${string}`
  if (!/^0x[0-9a-fA-F]{40}$/.test(priceOracle)) {
    throw new Error(`Invalid priceOracle address in ${ENV}.json`)
  }

  let signerAddress = process.env.SIGNER as `0x${string}` | undefined
  if (signerAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(signerAddress)) {
      throw new Error(`SIGNER is not a valid address: ${signerAddress}`)
    }
  } else {
    const multisigSigner = (
      aurora.contracts as Record<string, { multisigSigner: string }>
    )[ENV]?.multisigSigner
    if (!multisigSigner) {
      throw new Error(`No aurora multisigSigner configured for env "${ENV}"`)
    }
    const auroraClient = createPublicClient({ transport: http(aurora.rpc[0]) })
    signerAddress = (await deriveAllocatorSignerAddress(
      auroraClient,
      multisigSigner,
      "ethereum-vm"
    )) as `0x${string}` | undefined
    if (!signerAddress) throw new Error("Failed to derive signer")
  }

  const chain = ENV === "dev" ? relayTestnet : relayChain
  const rpcUrl = process.env.RPC_URL || chain.rpc[0]
  const client = createPublicClient({ transport: http(rpcUrl) })

  // reads against the wrong chain silently return empty values
  const liveChainId = await client.getChainId()
  if (BigInt(liveChainId) !== chain.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${chain.chainId} for env "${ENV}"`
    )
  }

  console.log(`env: ${ENV}`)
  console.log(`oracle: ${priceOracle}`)
  console.log(`signer (from): ${signerAddress}`)
  console.log(`rpc: ${rpcUrl}`)

  const owner = (await client.readContract({
    abi: RelayPriceOracle,
    address: priceOracle,
    functionName: "owner",
  })) as `0x${string}`
  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `Oracle owner ${owner} does not match signer ${signerAddress}. ` +
        "Set SIGNER to the oracle owner's MPC wallet."
    )
  }

  const blockNumber = await client.getBlockNumber()
  const adapter = (await client.readContract({
    abi: RelayPriceOracle,
    address: priceOracle,
    args: [STORK_PROVIDER_ID],
    blockNumber,
    functionName: "priceFeedAdapters",
  })) as string
  if (adapter === "0x0000000000000000000000000000000000000000") {
    throw new Error("Stork adapter is not registered")
  }
  const current: CurrentRoute[] = []
  for (let index = 0; index < storkPriceRoutes.length; index += 8) {
    current.push(
      ...(await Promise.all(
        storkPriceRoutes.slice(index, index + 8).map(
          (route) =>
            client.readContract({
              abi: RelayPriceOracle,
              address: priceOracle,
              args: [routeTokenId(route)],
              blockNumber,
              functionName: "feedRoutes",
            }) as Promise<CurrentRoute>
        )
      ))
    )
  }
  const missing = selectMissingRoutes(storkPriceRoutes, current)
  if (missing.length === 0) {
    console.log("All requested routes already match; no manifest written")
    return
  }
  console.log(
    `${missing.length} new routes; ${storkPriceRoutes.length - missing.length} already configured`
  )

  // Prove each routed feed is actually ingested: the precompile answers only
  // for feeds the sequencer serves, regardless of what the adapter is.
  const servedFeeds = new Set<StorkFeed>()
  await Promise.all(
    [...new Set(missing.map((route) => route.feed))].map(async (feed) => {
      try {
        const { data } = await client.call({
          blockNumber,
          data: concat([STORK_PROVIDER_ID, storkFeedId(feed)]),
          to: PRICE_ORACLE_PRECOMPILE,
        })
        if (data !== undefined && data !== "0x") servedFeeds.add(feed)
      } catch {
        // the precompile fails the call for feeds the sequencer does not serve
      }
    })
  )
  const { served, unserved } = checkServedFeeds(
    missing,
    servedFeeds,
    parseAllowedUnservedFeeds(process.env.ALLOW_UNSERVED_FEEDS)
  )
  console.log(`Feeds served by the sequencer: ${served.join(", ")}`)
  if (unserved.length) {
    const affected = missing.filter((route) => unserved.includes(route.feed))
    console.warn(
      `⚠️  ${unserved.length} feed(s) not served yet (allowed): ${unserved.join(", ")}; ` +
        `${affected.length} route(s) price nothing until the ingester adds them`
    )
  }

  const pendingNonce = await client.getTransactionCount({
    address: signerAddress,
    blockTag: "pending",
  })
  const nonce =
    process.env.START_NONCE === undefined
      ? pendingNonce
      : Number(process.env.START_NONCE)
  if (!Number.isSafeInteger(nonce) || nonce < pendingNonce) {
    throw new Error(`START_NONCE must be an integer at least ${pendingNonce}`)
  }
  if (nonce > pendingNonce) {
    console.log(
      `Starting at nonce ${nonce}; requires ${nonce - pendingNonce} earlier owner transactions`
    )
  }
  const txs = []
  // Bound gas per transaction; each batch is estimated independently as the owner.
  for (const batch of batchRoutes(missing, nonce)) {
    const { routes } = batch
    const calldata = encodeFunctionData({
      abi: RelayPriceOracle,
      args: [
        routes.map((r) => r.currency),
        routes.map((r) => r.providerId),
        routes.map((r) => r.feedId),
        routes.map((r) => r.currencyDecimals),
        routes.map((r) => r.maxAgeSeconds),
      ],
      functionName: "setFeedRoutes",
    })

    const gas = await client.estimateGas({
      account: signerAddress,
      data: calldata,
      to: priceOracle,
    })
    txs.push({
      amount: "0",
      calldata,
      family: "ethereum-vm",
      from: signerAddress,
      gas: ((gas * 120n) / 100n).toString(),
      maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
      maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
      nonce: batch.nonce,
      rpc: rpcUrl,
      to: priceOracle,
    })
    console.log(
      `Batch ${txs.length}: ${routes.length} routes, estimated gas ${gas}`
    )
  }

  const path = getManifestPath("set-feed-routes", "stork-expansion", ENV)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${stringifyJsonWithBigInt(txs)}\n`)

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
