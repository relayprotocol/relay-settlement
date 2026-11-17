/**
 * Generates a multisig manifest that registers the `bitcoin`, `hyperliquid`
 * and `lighter` payload builders on the prod Relay Chain deployment and seeds
 * the Config values their builders read.
 *
 * This is the multisig equivalent of the standalone, env-driven configure
 * scripts under `contracts/relay-chain/deployments/scripts/`:
 *   - configure-bitcoin-vm-payload-builder.ts
 *   - configure-hyperliquid-vm-payload-builder.ts
 *   - configure-lighter-vm-payload-builder.ts
 *
 * Actions emitted (RelayAllocator.owner == Config admin == multisig signer):
 *   bitcoin     -> Allocator.setPayloadBuilder
 *   hyperliquid -> Allocator.setPayloadBuilder
 *                  Config.setConfigValues (USDE spot, USDC spot, USDC perp)
 *   lighter     -> Config.setConfigValues (route types + asset indices, and the
 *                  app-chain id for a config-driven builder), then
 *                  Allocator.setPayloadBuilder
 *
 * The Lighter depository is the relay's own Lighter account index, read at
 * generation time so the manifest always matches on-chain state: from a legacy
 * builder's FROM_ACCOUNT_INDEX immutable, or, for a config-driven builder, from
 * the Config value behind getFromAccountIndexKey("lighter"). A config-driven
 * builder without that value refuses to generate; seed it first with
 * configure-lighter-vm-payload-builder.ts.
 *
 * Hyperliquid Config keys are derived locally with the exact scheme its
 * Solidity builder uses: keccak256(abi.encodePacked(keccak256(LABEL), chainId,
 * currency)). Lighter per-currency keys are read from the target builder's own
 * key getters, whose derivation differs between builder versions, and every
 * Lighter value is read back from Config first (lighter-vm-config-plan.ts):
 * keys already set are authoritative and never rewritten to the currency-set
 * default (drift is logged as [keep]), and an asset index of zero
 * (a disabled currency) is never overwritten unless it is listed in
 * REENABLE_CURRENCIES. Under PREVIOUS_PAYLOAD_BUILDER a currency whose new keys
 * are unset is migrated, not seeded: its legacy route types and asset index are
 * carried over as they are ([migrate] line when they differ from the currency
 * set), and a currency disabled or unset under the old keys is written as an
 * explicit 0 under the new keys ([disabled] warning), so re-running without env
 * keeps it disabled.
 *
 * Env (all optional):
 *   PREVIOUS_PAYLOAD_BUILDER  Lighter builder being replaced; a currency whose
 *                             keys are unset under the target builder takes its
 *                             values from this builder's keys, so a currency
 *                             disabled there stays disabled. Must differ from
 *                             the target; a builder under which none of the
 *                             consulted currencies is enabled is refused as a
 *                             wrong address
 *   REENABLE_CURRENCIES       comma-separated currency-set labels whose zero or
 *                             unset asset index may be written, e.g.
 *                             "ETH Spot,USDC Spot"; an unknown label is an error
 *   MIGRATION_REVIEWED        "1" to seed a builder whose Lighter currency keys
 *                             are all unset without PREVIOUS_PAYLOAD_BUILDER
 *                             (first-time configuration only)
 *   CONFIRM_DISABLE_ALL       "1" to accept a previous builder with no enabled
 *                             currency, writing asset index 0 for every one
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

import {
  parseReenableCurrencies,
  planLighterConfigWrites,
} from "../../../contracts/relay-chain/deployments/scripts/payload-builders/lighter-vm-config-plan"

// --- Prod Relay Chain (537713) deployment -----------------------------------
// Sourced from contracts/relay-chain/deployments/contracts/prod.json

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
// Lighter mainnet app-chain id signed into every transfer L1 message.
const LIGHTER_APP_CHAIN_ID = 304n

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
  "function getConfigValue(bytes32 key) view returns (bytes32)",
])
const LIGHTER_BUILDER_ABI = parseAbi([
  "function FROM_ACCOUNT_INDEX() view returns (uint64)",
  "function getFromRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getToRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getAssetIndexKey(string chainId, bytes currency) view returns (bytes32)",
  "function getFromAccountIndexKey(string chainId) view returns (bytes32)",
  "function getLighterChainIdKey(string chainId) view returns (bytes32)",
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

// Only the read surface the generator uses, so tests can pass a plain mock.
export type ReadClient = {
  readContract: (_args: {
    abi: unknown
    address: Hex
    args?: readonly unknown[]
    functionName: string
  }) => Promise<unknown>
}

const LIGHTER_CURRENCY_KEY_GETTERS = [
  "getFromRouteTypeKey",
  "getToRouteTypeKey",
  "getAssetIndexKey",
] as const

// Keys come from the target builder so the manifest matches whichever key
// derivation it uses; a builder without the getters is refused.
export const readLighterCurrencyKeys = async (
  client: ReadClient,
  builder: Hex
): Promise<Hex[][]> =>
  Promise.all(
    LIGHTER_CURRENCY_CONFIGS.map((entry) =>
      Promise.all(
        LIGHTER_CURRENCY_KEY_GETTERS.map(async (functionName) => {
          try {
            return (await client.readContract({
              abi: LIGHTER_BUILDER_ABI,
              address: builder,
              args: [LIGHTER_CHAIN_ID, entry.currency],
              functionName,
            })) as Hex
          } catch (error) {
            throw new Error(
              `LighterVmPayloadBuilder ${builder} has no ${functionName}(string,bytes) -- refusing to derive "${LIGHTER_CHAIN_ID}" ${entry.label} keys locally`,
              { cause: error }
            )
          }
        })
      )
    )
  )

export type LighterConfigOptions = {
  previousPayloadBuilder?: Hex
  reenableCurrencies?: string[]
  migrationReviewed?: boolean
  confirmDisableAll?: boolean
}

// Returns undefined when Config already holds every Lighter value.
export const buildLighterConfigCall = async (
  client: ReadClient,
  lighter: LighterInstance,
  options: LighterConfigOptions = {},
  builder: Hex = LIGHTER_VM_PAYLOAD_BUILDER
): Promise<Call | undefined> => {
  await readLighterCurrencyKeys(client, builder)
  const { keys, values } = await planLighterConfigWrites({
    chainId: LIGHTER_CHAIN_ID,
    client,
    config: CONFIG,
    currencies: LIGHTER_CURRENCY_CONFIGS,
    // Config-driven builder: also seed the app-chain id it signs with.
    instance: lighter.lighterChainIdKey
      ? {
          fromAccountIndex: lighter.accountIndex,
          lighterChainId: LIGHTER_APP_CHAIN_ID,
        }
      : undefined,
    // stdout carries the manifest JSON.
    log: (line) => console.error(line),
    payloadBuilder: builder,
    ...options,
  })
  if (keys.length === 0) return undefined

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

// Account index the Lighter depository withdraws from and, for a config-driven
// builder, the Config key of the app-chain id the manifest must seed.
export type LighterInstance = { accountIndex: bigint; lighterChainIdKey?: Hex }

const readLighterInstance = async (
  client: ReadClient
): Promise<LighterInstance> => {
  let accountIndexKey: Hex
  try {
    accountIndexKey = (await client.readContract({
      abi: LIGHTER_BUILDER_ABI,
      address: LIGHTER_VM_PAYLOAD_BUILDER,
      args: [LIGHTER_CHAIN_ID],
      functionName: "getFromAccountIndexKey",
    })) as Hex
  } catch {
    // Legacy builder: the account index is a constructor immutable.
    return {
      accountIndex: (await client.readContract({
        abi: LIGHTER_BUILDER_ABI,
        address: LIGHTER_VM_PAYLOAD_BUILDER,
        functionName: "FROM_ACCOUNT_INDEX",
      })) as bigint,
    }
  }
  const lighterChainIdKey = (await client.readContract({
    abi: LIGHTER_BUILDER_ABI,
    address: LIGHTER_VM_PAYLOAD_BUILDER,
    args: [LIGHTER_CHAIN_ID],
    functionName: "getLighterChainIdKey",
  })) as Hex
  let accountIndex: bigint
  try {
    accountIndex = BigInt(
      (await client.readContract({
        abi: CONFIG_ABI,
        address: CONFIG,
        args: [accountIndexKey],
        functionName: "getConfigValue",
      })) as Hex
    )
  } catch {
    throw new Error(
      `config-driven LighterVmPayloadBuilder ${LIGHTER_VM_PAYLOAD_BUILDER} has no account index configured for "${LIGHTER_CHAIN_ID}" -- seed it with configure-lighter-vm-payload-builder.ts first`
    )
  }
  return { accountIndex, lighterChainIdKey }
}

const main = async () => {
  const client = createPublicClient({ transport: http(RELAY_RPC) })

  // Lighter depository == the relay's own Lighter account index, taken from
  // on-chain state so the manifest can never drift from it.
  const reader = client as ReadClient
  const lighter = await readLighterInstance(reader)
  const previousPayloadBuilder = process.env.PREVIOUS_PAYLOAD_BUILDER
  const lighterConfigCall = await buildLighterConfigCall(reader, lighter, {
    confirmDisableAll: process.env.CONFIRM_DISABLE_ALL === "1",
    migrationReviewed: process.env.MIGRATION_REVIEWED === "1",
    previousPayloadBuilder: previousPayloadBuilder
      ? getAddress(previousPayloadBuilder)
      : undefined,
    reenableCurrencies: parseReenableCurrencies(
      process.env.REENABLE_CURRENCIES
    ),
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
    // Lighter: route types / asset indices (plus the app-chain id for a
    // config-driven builder), then the payload builder. Config goes first so
    // the builder can build from the moment it is registered.
    ...(lighterConfigCall ? [lighterConfigCall] : []),
    buildSetPayloadBuilderCall({
      builder: LIGHTER_VM_PAYLOAD_BUILDER,
      chainId: LIGHTER_CHAIN_ID,
      depository: bytesToHex(
        encodeAddress(lighter.accountIndex.toString(), "lighter-vm")
      ),
      label: "LighterVmPayloadBuilder",
    }),
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
