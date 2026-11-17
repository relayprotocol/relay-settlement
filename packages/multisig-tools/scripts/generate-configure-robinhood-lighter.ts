// ABOUTME: generates the multisig manifest that registers the Robinhood Lighter
// ABOUTME: LighterVmPayloadBuilder on the allocator and seeds its Config values.
//
// Robinhood Lighter is a second Lighter deployment (L1 Robinhood Chain 4663,
// app-chain id 466324) next to Lighter mainnet (L1 Ethereum, app-chain id 304),
// keyed on the allocator under its own Relay chain id: `lighter` and
// `robinhood-lighter`. Two builder generations are supported:
//   - config-driven (shared): one generic LighterVmPayloadBuilder serves both
//     deployments and reads the account index and app-chain id from Config;
//   - legacy (per deployment): the builder fixes FROM_ACCOUNT_INDEX and
//     LIGHTER_CHAIN_ID as constructor immutables.
//
// Both actions are gated on the allocator owner (Config resolves its admin from the
// allocator), which is the multisig-derived signer on dev, stag and prod:
//   1. Config.setConfigValues(keys, values)
//        LIGHTER_VM_FROM_ACCOUNT_INDEX[robinhood-lighter] = depository (config-driven only)
//        LIGHTER_VM_CHAIN_ID          [robinhood-lighter] = 466324     (config-driven only)
//        LIGHTER_VM_FROM_ROUTE_TYPE[robinhood-lighter][USDG] = 0   (perps account)
//        LIGHTER_VM_TO_ROUTE_TYPE  [robinhood-lighter][USDG] = 0
//        LIGHTER_VM_ASSET_INDEX    [robinhood-lighter][USDG] = 3
//   2. RelayAllocator.setPayloadBuilder(robinhood-lighter, encoded account index, builder)
//
// Before emitting anything the generator reads the deployed builder and refuses to
// continue unless CONFIG is the env's Config store and, for a legacy builder,
// LIGHTER_CHAIN_ID is 466324 and FROM_ACCOUNT_INDEX is the depository account
// index recorded for the env (DEC-1927). For a config-driven builder those two
// values are written to Config instead.
// Calls whose on-chain state already matches are skipped, and a Config key that
// is already set is never rewritten to the currency-set default (drift is
// logged as [keep]), so re-running after a partial execution only emits what is
// still missing. The Config write is emitted
// before the registration: a config-driven builder reverts with ConfigValueNotSet
// until its instance values exist, so registering it first would fail every
// withdrawal on an already-live chain until the Config write landed.
//
// Env:
//   ENV              dev | stag | prod (required). dev targets the relay testnet
//                    chain (537724); dev privileged changes go through the multisig
//                    flow like stag/prod.
//   PAYLOAD_BUILDER  optional 0x builder address. Defaults to the env's shared
//                    payloadBuilders.lighterVmPayloadBuilder, which is also what
//                    verify-deployment expects for every lighter-vm chain. Pass
//                    the legacy payloadBuilders.robinhoodLighterVmPayloadBuilder
//                    here explicitly to re-run the pre-migration configuration.
//   SIGNER           optional 0x signer address to use as `from`. When set, the
//                    NEAR/MPC derivation is skipped.
//   RELAY_NONCE_OFFSET  optional number added to the on-chain nonce, for relay-chain
//                    transactions queued in earlier manifests but not yet mined.
//   PREVIOUS_PAYLOAD_BUILDER  optional 0x address of the builder PAYLOAD_BUILDER
//                    replaces. A currency whose keys are unset under PAYLOAD_BUILDER
//                    is migrated from this builder's keys: its legacy route types
//                    and asset index are carried over as they are, and a zero or
//                    unset legacy asset index is written as an explicit 0 under
//                    the new key, so a re-run without env keeps the currency
//                    disabled. Must differ from PAYLOAD_BUILDER; one under which
//                    no consulted currency is enabled is refused as a wrong address.
//   REENABLE_CURRENCIES  comma-separated currency-set labels (e.g. "USDG Perp")
//                    whose zero or unset asset index may be written; otherwise
//                    the currency stays at 0 with a [disabled] warning. An
//                    unknown label is an error.
//   MIGRATION_REVIEWED  "1" to configure a builder whose currency keys are all
//                    unset without PREVIOUS_PAYLOAD_BUILDER (first-time setup only).
//   CONFIRM_DISABLE_ALL  "1" to accept a previous builder with no enabled currency,
//                    writing asset index 0 for every currency (USDG is the only
//                    one, so carrying a disabled USDG over needs this flag).
//
// Usage:
//   ENV=dev yarn workspace @relay-settlement/multisig-tools tsx \
//     scripts/generate-configure-robinhood-lighter.ts
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Hex,
  toFunctionSelector,
} from "viem"
import {
  relay as relayChain,
  relayTestnet,
  aurora,
} from "@relay-protocol/settlement-networks"
import { encodeAddress } from "@relay-protocol/settlement-sdk"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import {
  parseReenableCurrencies,
  planLighterConfigWrites,
} from "../../../contracts/relay-chain/deployments/scripts/payload-builders/lighter-vm-config-plan"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

export type Env = "dev" | "stag" | "prod"

export const ROBINHOOD_LIGHTER_CHAIN_ID = "robinhood-lighter"
export const ROBINHOOD_LIGHTER_APP_CHAIN_ID = 466324n

// Depository account index per env, as created in DEC-1927. A legacy builder's
// FROM_ACCOUNT_INDEX must match; a config-driven builder has it written to Config.
export const ROBINHOOD_LIGHTER_DEPOSITORIES: Partial<Record<Env, string>> = {
  dev: "28482",
  prod: "33627",
  stag: "31157",
}

// Mirrors contracts/relay-chain/deployments/scripts/payload-builders/lighter-vm-currency-sets.ts
// (ROBINHOOD_LIGHTER_CURRENCIES). USDG is the collateral asset of the perps
// account (route type 0); account reads on api.rh.lighter.xyz report asset_id 3.
export type LighterCurrencyConfig = {
  assetIndex: bigint
  currency: Hex
  label: string
  routeType: bigint
}
export const ROBINHOOD_LIGHTER_CURRENCIES: LighterCurrencyConfig[] = [
  {
    assetIndex: 3n,
    currency: `0x${"00".repeat(16)}`,
    label: "USDG Perp",
    routeType: 0n,
  },
]

const allocatorAbi = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
  "function payloadBuilders(string chainId, bytes depository) view returns (address)",
])

const configAbi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
])

// Key derivation lives in the builder as `pure` getters; read them rather than re-deriving
// here so the manifest cannot drift from the contract.
const builderAbi = parseAbi([
  "function CONFIG() view returns (address)",
  "function FROM_ACCOUNT_INDEX() view returns (uint64)",
  "function LIGHTER_CHAIN_ID() view returns (uint64)",
  "function getFromRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getToRouteTypeKey(string chainId, bytes currency) view returns (bytes32)",
  "function getAssetIndexKey(string chainId, bytes currency) view returns (bytes32)",
  "function getFromAccountIndexKey(string chainId) view returns (bytes32)",
  "function getLighterChainIdKey(string chainId) view returns (bytes32)",
])

export type Call = { calldata: Hex; label: string; to: Hex }

// Only the read surface the generator uses, so tests can pass a plain mock.
export type ReadClient = {
  getCode: (_args: { address: Hex }) => Promise<Hex | undefined>
  readContract: (_args: {
    abi: unknown
    address: Hex
    args?: readonly unknown[]
    functionName: string
  }) => Promise<unknown>
}

// `buildPayload` signatures the allocator may call. #769 (DEC-1997) added
// `requestHash` to BuildPayloadParams and #808 replaced the params with the whole
// `WithdrawRequest`; each change moves the selector, so a builder compiled on one
// side of it can never be called by an allocator deployed on the other, and the
// failure is a bare revert at withdrawal time.
export const BUILD_PAYLOAD_SELECTORS = {
  fullRequest: toFunctionSelector(
    "buildPayload(string,bytes,(string,bytes,bytes,uint256,string,bytes,bytes,bytes,bytes32))"
  ),
  legacy: toFunctionSelector(
    "buildPayload(string,bytes,(bytes,uint256,bytes,uint256,bytes))"
  ),
  requestHash: toFunctionSelector(
    "buildPayload(string,bytes,(bytes,uint256,bytes,uint256,bytes,bytes32))"
  ),
} as const

type BuildPayloadAbi = keyof typeof BUILD_PAYLOAD_SELECTORS

/**
 * Which known `buildPayload` selectors a contract's runtime code contains. The
 * allocator embeds the selector it calls; the builder embeds the one it
 * dispatches on. A 4-byte match in unrelated code is possible in theory, so
 * this is a guard against the known #769 mismatch, not a full ABI check.
 */
export const buildPayloadAbisIn = (
  code: Hex | undefined
): BuildPayloadAbi[] => {
  const body = (code ?? "0x").slice(2).toLowerCase()
  return (Object.keys(BUILD_PAYLOAD_SELECTORS) as BuildPayloadAbi[]).filter(
    (abi) => body.includes(BUILD_PAYLOAD_SELECTORS[abi].slice(2).toLowerCase())
  )
}

const isAddress = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)

export type BuildCallsInput = {
  allocator: Hex
  client: ReadClient
  config: Hex
  currencies?: LighterCurrencyConfig[]
  depository: string
  confirmDisableAll?: boolean
  migrationReviewed?: boolean
  payloadBuilder: Hex
  previousPayloadBuilder?: Hex
  reenableCurrencies?: string[]
}

/**
 * Reads the deployed builder, asserts its wiring (and, for a legacy builder, its
 * immutables), and returns the calls whose on-chain state does not already
 * match. Pure with respect to the file system.
 */
export const buildRobinhoodLighterCalls = async ({
  allocator,
  client,
  config,
  currencies = ROBINHOOD_LIGHTER_CURRENCIES,
  depository,
  confirmDisableAll = false,
  migrationReviewed = false,
  payloadBuilder,
  previousPayloadBuilder,
  reenableCurrencies = [],
}: BuildCallsInput): Promise<Call[]> => {
  const read = (functionName: string, args?: readonly unknown[]) =>
    client.readContract({
      abi: builderAbi,
      address: payloadBuilder,
      args,
      functionName,
    })

  const builderConfig = (await read("CONFIG")) as Hex
  if (
    !isAddress(builderConfig) ||
    builderConfig.toLowerCase() !== config.toLowerCase()
  ) {
    throw new Error(
      `builder ${payloadBuilder} reads CONFIG=${builderConfig}, expected ${config}`
    )
  }

  // A config-driven builder exposes the instance key getters; a legacy builder
  // reverts on them and carries the values as immutables instead.
  let instanceKeys: [Hex, Hex] | undefined
  try {
    instanceKeys = (await Promise.all([
      read("getFromAccountIndexKey", [ROBINHOOD_LIGHTER_CHAIN_ID]),
      read("getLighterChainIdKey", [ROBINHOOD_LIGHTER_CHAIN_ID]),
    ])) as [Hex, Hex]
  } catch {
    instanceKeys = undefined
  }

  if (!instanceKeys) {
    const [fromAccountIndex, lighterChainId] = (await Promise.all([
      read("FROM_ACCOUNT_INDEX"),
      read("LIGHTER_CHAIN_ID"),
    ])) as [bigint, bigint]
    if (BigInt(lighterChainId) !== ROBINHOOD_LIGHTER_APP_CHAIN_ID) {
      throw new Error(
        `builder ${payloadBuilder} signs for Lighter app-chain id ${lighterChainId}, expected ${ROBINHOOD_LIGHTER_APP_CHAIN_ID} (Robinhood Lighter)`
      )
    }
    if (BigInt(fromAccountIndex) !== BigInt(depository)) {
      throw new Error(
        `builder ${payloadBuilder} withdraws from account ${fromAccountIndex}, expected depository ${depository}`
      )
    }
  }

  const [allocatorCode, builderCode] = await Promise.all([
    client.getCode({ address: allocator }),
    client.getCode({ address: payloadBuilder }),
  ])
  const allocatorAbis = buildPayloadAbisIn(allocatorCode)
  const builderAbis = buildPayloadAbisIn(builderCode)
  if (allocatorAbis.length !== 1) {
    throw new Error(
      `cannot tell which buildPayload ABI allocator ${allocator} calls (found: ${allocatorAbis.join(", ") || "none"})`
    )
  }
  if (!builderAbis.includes(allocatorAbis[0])) {
    throw new Error(
      `builder ${payloadBuilder} exposes buildPayload(${builderAbis.join("/") || "none"}) but allocator ${allocator} calls buildPayload(${allocatorAbis[0]}); compile the builder from the same contracts revision as the deployed allocator`
    )
  }

  const calls: Call[] = []
  const depositoryEncoded = bytesToHex(encodeAddress(depository, "lighter-vm"))

  const registered = (await client.readContract({
    abi: allocatorAbi,
    address: allocator,
    args: [ROBINHOOD_LIGHTER_CHAIN_ID, depositoryEncoded],
    functionName: "payloadBuilders",
  })) as Hex
  if (registered.toLowerCase() === payloadBuilder.toLowerCase()) {
    console.log(
      `  [skip] ${ROBINHOOD_LIGHTER_CHAIN_ID} builder already registered`
    )
  } else {
    calls.push({
      calldata: encodeFunctionData({
        abi: allocatorAbi,
        args: [ROBINHOOD_LIGHTER_CHAIN_ID, depositoryEncoded, payloadBuilder],
        functionName: "setPayloadBuilder",
      }),
      label: `allocator.setPayloadBuilder(${ROBINHOOD_LIGHTER_CHAIN_ID}, ${depository}, ${payloadBuilder}) [was ${registered}]`,
      to: allocator,
    })
  }

  // Every value is read back first; a disabled currency's asset index is
  // only written when its label is in reenableCurrencies.
  const { keys, values } = await planLighterConfigWrites({
    chainId: ROBINHOOD_LIGHTER_CHAIN_ID,
    client,
    config,
    confirmDisableAll,
    currencies,
    instance: instanceKeys
      ? {
          fromAccountIndex: BigInt(depository),
          lighterChainId: ROBINHOOD_LIGHTER_APP_CHAIN_ID,
        }
      : undefined,
    migrationReviewed,
    payloadBuilder,
    previousPayloadBuilder,
    reenableCurrencies,
  })

  // Config values go ahead of the registration (see header).
  if (keys.length > 0) {
    calls.unshift({
      calldata: encodeFunctionData({
        abi: configAbi,
        args: [keys, values],
        functionName: "setConfigValues",
      }),
      label: `config.setConfigValues(${keys.length} keys)`,
      to: config,
    })
  }

  return calls
}

/**
 * Builder the manifest configures: an explicit override, else the env's shared
 * `lighterVmPayloadBuilder`. The legacy `robinhoodLighterVmPayloadBuilder` entry
 * is never picked implicitly, so the generator and verify-deployment agree.
 */
export const resolvePayloadBuilder = (
  payloadBuilders: Record<string, string>,
  override?: string
): string | undefined => override ?? payloadBuilders.lighterVmPayloadBuilder

const requireAddressEnv = (name: string): Hex => {
  const value = process.env[name]
  if (!isAddress(value)) {
    throw new Error(`${name} is not a valid address: ${String(value)}`)
  }
  return value
}

const main = async () => {
  const env = process.env.ENV as Env | undefined
  if (env !== "dev" && env !== "stag" && env !== "prod") {
    throw new Error(`ENV must be dev, stag or prod (got "${String(env)}")`)
  }

  const depository = ROBINHOOD_LIGHTER_DEPOSITORIES[env]
  if (!depository) {
    throw new Error(
      `No Robinhood Lighter depository account index recorded for env "${env}" -- add it to ROBINHOOD_LIGHTER_DEPOSITORIES once DEC-1927 creates the account`
    )
  }

  const deploymentFile = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../contracts/relay-chain/deployments/contracts/${env}.json`
      ),
      "utf8"
    )
  ) as { core: Record<string, string>; payloadBuilders: Record<string, string> }

  const allocator = deploymentFile.core.allocator
  const config = deploymentFile.core.config
  if (!isAddress(allocator) || !isAddress(config)) {
    throw new Error(
      `core.allocator / core.config missing from contracts/${env}.json`
    )
  }
  const payloadBuilder = resolvePayloadBuilder(
    deploymentFile.payloadBuilders,
    process.env.PAYLOAD_BUILDER
      ? requireAddressEnv("PAYLOAD_BUILDER")
      : undefined
  )
  if (!isAddress(payloadBuilder)) {
    throw new Error(
      `payloadBuilders.lighterVmPayloadBuilder missing from contracts/${env}.json -- deploy the shared builder (yarn deploy:lighter-vm-payload-builder) and record the address first, or pass PAYLOAD_BUILDER`
    )
  }

  let signerAddress = process.env.SIGNER as Hex | undefined
  if (signerAddress) {
    if (!isAddress(signerAddress)) {
      throw new Error(`SIGNER is not a valid address: ${signerAddress}`)
    }
  } else {
    const multisigSigner = aurora.contracts?.[env]?.multisigSigner
    if (!multisigSigner) {
      throw new Error(`No aurora multisigSigner configured for env "${env}"`)
    }
    const auroraClient = createPublicClient({ transport: http(aurora.rpc[0]) })
    signerAddress = (await deriveAllocatorSignerAddress(
      auroraClient,
      multisigSigner,
      "ethereum-vm"
    )) as Hex | undefined
    if (!signerAddress) throw new Error("Failed to derive signer")
  }
  console.log(`env: ${env}`)
  console.log(`Using signer from MPC : ${signerAddress}`)

  const chain = env === "dev" ? relayTestnet : relayChain
  const rpcUrl = chain.rpc[0]
  const relayChainClient = createPublicClient({ transport: http(rpcUrl) })
  // reads against the wrong chain silently return empty values
  const liveChainId = await relayChainClient.getChainId()
  if (BigInt(liveChainId) !== chain.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${chain.chainId} for env "${env}"`
    )
  }
  const builderCode = await relayChainClient.getCode({
    address: payloadBuilder,
  })
  if (!builderCode || builderCode === "0x") {
    throw new Error(
      `PAYLOAD_BUILDER ${payloadBuilder} has no code on the relay chain -- deploy it first`
    )
  }

  const calls = await buildRobinhoodLighterCalls({
    allocator,
    client: relayChainClient as ReadClient,
    config,
    confirmDisableAll: process.env.CONFIRM_DISABLE_ALL === "1",
    depository,
    migrationReviewed: process.env.MIGRATION_REVIEWED === "1",
    payloadBuilder,
    previousPayloadBuilder: process.env.PREVIOUS_PAYLOAD_BUILDER
      ? requireAddressEnv("PREVIOUS_PAYLOAD_BUILDER")
      : undefined,
    reenableCurrencies: parseReenableCurrencies(
      process.env.REENABLE_CURRENCIES
    ),
  })
  if (calls.length === 0) {
    console.log("Nothing to do -- builder and config already match")
    return
  }

  const nonceOffset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  const [baseNonce, gasEstimates] = await Promise.all([
    relayChainClient
      .getTransactionCount({ address: signerAddress })
      .then((count) => count + nonceOffset),
    Promise.all(
      calls.map((call) =>
        relayChainClient.estimateGas({
          account: signerAddress,
          data: call.calldata,
          to: call.to,
        })
      )
    ),
  ])

  const txs = calls.map((call, i) => {
    console.log(`  [nonce ${baseNonce + i}] ${call.label}`)
    return {
      amount: "0",
      calldata: call.calldata,
      family: "ethereum-vm",
      from: signerAddress,
      gas: ((gasEstimates[i] * 110n) / 100n).toString(),
      maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
      maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
      nonce: baseNonce + i,
      rpc: rpcUrl,
      to: call.to,
    }
  })

  const path = getManifestPath("configure-robinhood-lighter", env, env)
  writeFileSync(path, `${stringifyJsonWithBigInt(txs)}\n`)

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
