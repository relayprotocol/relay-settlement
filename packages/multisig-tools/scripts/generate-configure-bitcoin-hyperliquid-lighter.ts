/**
 * Generates a multisig manifest that registers the `bitcoin`, `hyperliquid`
 * and `lighter` payload builders on the prod Relay Chain deployment and seeds
 * the Config values their builders read.
 *
 * This is the multisig equivalent of the standalone, env-driven configure
 * scripts under `smart-contracts/deployments/scripts/`:
 *   - configure-bitcoin-vm-payload-builder.ts
 *   - configure-hyperliquid-vm-payload-builder.ts
 *   - configure-lighter-vm-payload-builder.ts
 *
 * Actions emitted (RelayAllocator.owner == Config admin == multisig signer):
 *   bitcoin     -> Allocator.setPayloadBuilder
 *   hyperliquid -> Allocator.setPayloadBuilder
 *                  Config.setConfigValues (USDE spot, USDC spot, USDC perp)
 *   lighter     -> Allocator.setPayloadBuilder
 *                  Config.setConfigValues (route types + asset indices)
 *
 * The Lighter depository is the relay's own Lighter account index, read from
 * the deployed LighterVmPayloadBuilder's FROM_ACCOUNT_INDEX at generation time
 * so the manifest always matches the on-chain builder.
 *
 * Config keys are derived locally with the exact scheme the Solidity builders
 * use: keccak256(abi.encodePacked(keccak256(LABEL), chainId, currency)).
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools \
 *     tsx scripts/generate-configure-bitcoin-hyperliquid-lighter.ts \
 *     > transactions/052-configure-bitcoin-hyperliquid-lighter.json
 */
import { encodeAddress } from "@relay-protocol/settlement-sdk"
import {
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
  toHex,
  type Hex,
} from "viem"

// --- Prod Relay Chain (537713) deployment -----------------------------------
// Sourced from smart-contracts/deployments/hub-contracts/prod.json

const RELAY_RPC = "https://rpc.chain.relay.link"
const CONFIG = getAddress("0x8162BeeC776442afd262B672730Bb5d0d8af16A1")
const ALLOCATOR = getAddress("0x613D3c588F6B8f89302b463F8F19f7241B2857E2")
// RelayAllocator owner == Config admin == multisig signer that sends these txs.
const FROM = getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A")

const BITCOIN_VM_PAYLOAD_BUILDER = getAddress(
  "0xCB3807C1d9605B2dE68566Ff89986fDA5d549eDb"
)
const HYPERLIQUID_VM_PAYLOAD_BUILDER = getAddress(
  "0x69719e3B08C6f12Dd89A84A9B0f33dEfd762c94E"
)
const LIGHTER_VM_PAYLOAD_BUILDER = getAddress(
  "0xb92fCe45e18ed12A28De39eC5C60B5120f36404E"
)

// Relay chain id strings keyed by the allocator (slug form, matching the
// existing prod payload-builder registrations e.g. "ton", "tron").
const BITCOIN_CHAIN_ID = "bitcoin"
const HYPERLIQUID_CHAIN_ID = "hyperliquid"
const LIGHTER_CHAIN_ID = "lighter"

// Depositories (SDK-encoded to the bytes the allocator keys on).
const BITCOIN_DEPOSITORY = "bc1qzmtn0q92ayejt2hpffvlktcpmyy7vvsd06sefu"
const HYPERLIQUID_DEPOSITORY = "0x66CF0aace1b4E562593beC10eC7868Fba9932224"

// --- Hyperliquid currency metadata (mirrors the configure script) -----------

type HyperliquidSpotConfig = {
  currency: Hex
  label: string
  symbol: string
  targetDecimals: bigint
  sourceDex: string
  destinationDex: string
}

const HYPERLIQUID_SPOT_CONFIGS: HyperliquidSpotConfig[] = [
  {
    currency: "0x2e6d84f2d7ca82e6581e03523e4389f7",
    destinationDex: "spot",
    label: "USDE spot",
    sourceDex: "spot",
    symbol: "USDE",
    targetDecimals: 2n,
  },
  {
    currency: "0x6d1e7cde53ba9467b783cb7c530ce054",
    destinationDex: "spot",
    label: "USDC spot",
    sourceDex: "spot",
    symbol: "USDC",
    targetDecimals: 8n,
  },
]

const HYPERLIQUID_PERP_USDC_CURRENCY =
  "0x00000000000000000000000000000000" as Hex
const HYPERLIQUID_PERP_USDC_TARGET_DECIMALS = 8n

// --- Lighter currency metadata (mirrors the configure script) ---------------

type LighterCurrencyConfig = {
  currency: Hex
  label: string
  routeType: bigint
  assetIndex: bigint
}

const LIGHTER_CURRENCY_CONFIGS: LighterCurrencyConfig[] = [
  {
    assetIndex: 3n,
    currency: "0x00000000000000000000000000000000",
    label: "USDC Perp",
    routeType: 0n,
  },
  {
    assetIndex: 1n,
    currency: "0x00000000000000000000000000000001",
    label: "ETH Spot",
    routeType: 1n,
  },
  {
    assetIndex: 3n,
    currency: "0x00000000000000000000000000000003",
    label: "USDC Spot",
    routeType: 1n,
  },
]

// --- ABIs --------------------------------------------------------------------

const ALLOCATOR_ABI = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])
const CONFIG_ABI = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
])
const LIGHTER_BUILDER_ABI = parseAbi([
  "function FROM_ACCOUNT_INDEX() view returns (uint64)",
])

// --- Config key derivation (must match the Solidity payload builders) --------
// key = keccak256(abi.encodePacked(keccak256(LABEL), chainId, currency))

const labelPrefix = (label: string): Hex => keccak256(toBytes(label))
const configKey = (label: string, chainId: string, currency: Hex): Hex =>
  keccak256(
    encodePacked(
      ["bytes32", "string", "bytes"],
      [labelPrefix(label), chainId, currency]
    )
  )

const uint256Value = (v: bigint): Hex => toHex(v, { size: 32 })
const bytes32String = (value: string): Hex => {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length > 32) {
    throw new Error(`"${value}" does not fit in 32 bytes`)
  }
  return `0x${bytes.toString("hex").padEnd(64, "0")}` as Hex
}

// --- Manifest assembly -------------------------------------------------------

type Call = { description: string; to: Hex; calldata: Hex }

const buildHyperliquidConfigCall = (): Call => {
  const keys: Hex[] = []
  const values: Hex[] = []

  for (const entry of HYPERLIQUID_SPOT_CONFIGS) {
    keys.push(
      configKey(
        "HYPERLIQUID_VM_CURRENCY_SYMBOL",
        HYPERLIQUID_CHAIN_ID,
        entry.currency
      ),
      configKey(
        "HYPERLIQUID_VM_TARGET_DECIMALS",
        HYPERLIQUID_CHAIN_ID,
        entry.currency
      ),
      configKey(
        "HYPERLIQUID_VM_SOURCE_DEX",
        HYPERLIQUID_CHAIN_ID,
        entry.currency
      ),
      configKey(
        "HYPERLIQUID_VM_DESTINATION_DEX",
        HYPERLIQUID_CHAIN_ID,
        entry.currency
      )
    )
    values.push(
      bytes32String(entry.symbol),
      uint256Value(entry.targetDecimals),
      bytes32String(entry.sourceDex),
      bytes32String(entry.destinationDex)
    )
  }

  // Perp USDC only needs target decimals.
  keys.push(
    configKey(
      "HYPERLIQUID_VM_TARGET_DECIMALS",
      HYPERLIQUID_CHAIN_ID,
      HYPERLIQUID_PERP_USDC_CURRENCY
    )
  )
  values.push(uint256Value(HYPERLIQUID_PERP_USDC_TARGET_DECIMALS))

  return {
    calldata: encodeFunctionData({
      abi: CONFIG_ABI,
      args: [keys, values],
      functionName: "setConfigValues",
    }),
    description: `Config.setConfigValues hyperliquid (${keys.length} entries)`,
    to: CONFIG,
  }
}

const buildLighterConfigCall = (): Call => {
  const keys: Hex[] = []
  const values: Hex[] = []

  for (const entry of LIGHTER_CURRENCY_CONFIGS) {
    const routeValue = uint256Value(entry.routeType)
    keys.push(
      configKey("LIGHTER_VM_FROM_ROUTE_TYPE", LIGHTER_CHAIN_ID, entry.currency),
      configKey("LIGHTER_VM_TO_ROUTE_TYPE", LIGHTER_CHAIN_ID, entry.currency),
      configKey("LIGHTER_VM_ASSET_INDEX", LIGHTER_CHAIN_ID, entry.currency)
    )
    values.push(routeValue, routeValue, uint256Value(entry.assetIndex))
  }

  return {
    calldata: encodeFunctionData({
      abi: CONFIG_ABI,
      args: [keys, values],
      functionName: "setConfigValues",
    }),
    description: `Config.setConfigValues lighter (${keys.length} entries)`,
    to: CONFIG,
  }
}

const buildSetPayloadBuilderCall = (args: {
  chainId: string
  depository: Hex
  builder: Hex
  label: string
}): Call => ({
  calldata: encodeFunctionData({
    abi: ALLOCATOR_ABI,
    args: [args.chainId, args.depository, args.builder],
    functionName: "setPayloadBuilder",
  }),
  description: `Allocator.setPayloadBuilder(${args.chainId}, ${args.label})`,
  to: ALLOCATOR,
})

const main = async () => {
  const client = createPublicClient({ transport: http(RELAY_RPC) })

  // Lighter depository == the relay's own Lighter account index, taken from
  // the deployed builder so the manifest can never drift from on-chain.
  const lighterAccountIndex = await client.readContract({
    abi: LIGHTER_BUILDER_ABI,
    address: LIGHTER_VM_PAYLOAD_BUILDER,
    functionName: "FROM_ACCOUNT_INDEX",
  })

  const calls: Call[] = [
    // Bitcoin: payload builder only (no Config values).
    buildSetPayloadBuilderCall({
      builder: BITCOIN_VM_PAYLOAD_BUILDER,
      chainId: BITCOIN_CHAIN_ID,
      depository: bytesToHex(encodeAddress(BITCOIN_DEPOSITORY, "bitcoin-vm")),
      label: "BitcoinVmPayloadBuilder",
    }),
    // Hyperliquid: payload builder + currency metadata.
    buildSetPayloadBuilderCall({
      builder: HYPERLIQUID_VM_PAYLOAD_BUILDER,
      chainId: HYPERLIQUID_CHAIN_ID,
      depository: bytesToHex(
        encodeAddress(HYPERLIQUID_DEPOSITORY, "hyperliquid-vm")
      ),
      label: "HyperliquidVmPayloadBuilder",
    }),
    buildHyperliquidConfigCall(),
    // Lighter: payload builder + route types / asset indices.
    buildSetPayloadBuilderCall({
      builder: LIGHTER_VM_PAYLOAD_BUILDER,
      chainId: LIGHTER_CHAIN_ID,
      depository: bytesToHex(
        encodeAddress(lighterAccountIndex.toString(), "lighter-vm")
      ),
      label: "LighterVmPayloadBuilder",
    }),
    buildLighterConfigCall(),
  ]

  const fees = await client.estimateFeesPerGas()
  let nonce = await client.getTransactionCount({ address: FROM })

  const txs = []
  for (const call of calls) {
    // estimateGas also validates the call succeeds from the owner account.
    const gas = await client.estimateGas({
      account: FROM,
      data: call.calldata,
      to: call.to,
      value: parseEther("0"),
    })
    txs.push({
      amount: "0",
      calldata: call.calldata,
      family: "ethereum-vm",
      from: FROM,
      gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas!.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString(),
      nonce: nonce++,
      rpc: RELAY_RPC,
      to: call.to,
    })
    console.error(`✓ ${call.description}`)
  }

  console.log(JSON.stringify(txs, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
