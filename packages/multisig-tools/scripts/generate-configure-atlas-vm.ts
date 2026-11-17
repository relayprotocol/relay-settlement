// ABOUTME: generates the multisig manifest that seeds the AtlasVmPayloadBuilder's
// ABOUTME: Config values and registers it for the Atlas depository on the allocator.
//
// Both actions are gated on the allocator owner (Config resolves its admin from the
// allocator), which is the multisig-derived signer on dev, stag, prod and test:
//   1. Config.setConfigValues(keys, values)
//        ATLAS_VM_DOMAIN_CHAIN_ID     [chain]       = EIP-712 domain chain id
//        ATLAS_VM_DOMAIN_SALT         [chain]       = EIP-712 domain salt
//        ATLAS_VM_EXPIRATION          [chain]       = seconds a built withdrawal stays bookable
//        ATLAS_VM_ASSET_DECIMALS      [chain][asset] = asset decimals
//   2. RelayAllocator.setPayloadBuilder(chain, depository, AtlasVmPayloadBuilder)
//
// The Config write is emitted first: the builder reverts with ConfigValueNotSet until
// its keys exist. Keys are read from the deployed builder's getters so the manifest
// cannot drift from the contract, and the generator refuses to continue unless the
// builder's CONFIG is the env's Config store. Asset decimals are checked against
// Atlas `getAssets` before they are written. Calls whose on-chain state already
// matches are skipped, and a mismatching existing value aborts the run, except the
// one registered builder an instance names in `replacesBuilder` and the one domain
// chain id it names in `replacesDomainChainId`.
//
// Env:
//   ENV              dev or test (required; the envs with an Atlas domain and depository)
//   ATLAS_API_KEY    Atlas gateway API key, for the `getAssets` check (required)
//   RELAY_NONCE_OFFSET  optional number added to the on-chain nonce, for relay-chain
//                    transactions queued in earlier manifests but not yet mined.
//
// Usage:
//   ENV=dev ATLAS_API_KEY=… yarn workspace @relay-settlement/multisig-tools tsx \
//     scripts/generate-configure-atlas-vm.ts
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  BaseError,
  ContractFunctionRevertedError,
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  toHex,
  type Hex,
} from "viem"
import { networks, relayTestnet } from "@relay-protocol/settlement-networks"
import { encodeAddress } from "@relay-protocol/settlement-sdk"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"
import { buildPayloadAbisIn } from "./generate-configure-robinhood-lighter"

export type AtlasAsset = { currency: Hex; decimals: bigint; label: string }

export type AtlasInstance = {
  /** Relay chain id the allocator and oracle use for this Atlas deployment. */
  chainId: string
  /** Atlas gateway serving `getAssets` for this deployment. */
  gateway: string
  /** Depository account: the Lit allocator's `wallet` address for the env's PKP. */
  depository: Hex
  domainChainId: bigint
  domainSalt: Hex
  /** Seconds after the Hub block during which Atlas still books a built withdrawal. */
  expirationDelay: bigint
  assets: AtlasAsset[]
  /** Builder registered for the depository that this deployment's builder replaces. */
  replacesBuilder?: Hex
  /** Domain chain id stored in Config that `domainChainId` replaces. */
  replacesDomainChainId?: bigint
}

// Atlas testnet transaction domain; the depository is the dev PKP's atlas-vm wallet.
// USDT is asset 2 at 6 decimals. dev keeps the Oct 29 domain chain id its Lit action signs.
export const ATLAS_INSTANCES: Partial<Record<"dev" | "test", AtlasInstance>> = {
  dev: {
    assets: [
      {
        currency: `0x${"00".repeat(15)}02`,
        decimals: 6n,
        label: "USDT",
      },
    ],
    chainId: "atlas-testnet",
    depository: "0xB6a4a4d0Ac6Cfe49653a0410d6A450De3A005f17",
    domainChainId: 21337n,
    domainSalt:
      "0xcc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338",
    expirationDelay: 3600n,
    gateway: "https://testnet.gll.dev",
  },
  // The test PKP's atlas-vm wallet on the Nov 9 domain (chain id 43003); its builder
  // replaces the one signing the Oct 29 schema
  test: {
    assets: [
      {
        currency: `0x${"00".repeat(15)}02`,
        decimals: 6n,
        label: "USDT",
      },
    ],
    chainId: "atlas-testnet",
    depository: "0x3cB66889e23A8C17bDC995F7d3cC4D39Ab29f1cA",
    domainChainId: 43003n,
    domainSalt:
      "0xcc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338",
    expirationDelay: 3600n,
    gateway: "https://testnet.gll.dev",
    replacesBuilder: "0x7ddaAe85BEEFF27A2fC304545e4Ab464e1A705E9",
    replacesDomainChainId: 21337n,
  },
}

const allocatorAbi = parseAbi([
  "function owner() view returns (address)",
  "function payloadBuilders(string chainId, bytes depository) view returns (address)",
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

const configAbi = parseAbi([
  "function getConfigValue(bytes32 key) view returns (bytes32)",
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
  "error ConfigValueNotSet(bytes32 key)",
])

const builderAbi = parseAbi([
  "function CONFIG() view returns (address)",
  "function getDomainChainIdKey(string chainId) view returns (bytes32)",
  "function getDomainSaltKey(string chainId) view returns (bytes32)",
  "function getExpirationKey(string chainId) view returns (bytes32)",
  "function getAssetDecimalsKey(string chainId, bytes currency) view returns (bytes32)",
])

const ZERO_ADDRESS = `0x${"00".repeat(20)}`

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

/** Atlas asset decimals by asset id, as `atlas.getAssets` reports them. */
export type AssetDecimals = Map<number, number>

const readConfigValue = async (
  client: ReadClient,
  config: Hex,
  key: Hex
): Promise<Hex | undefined> => {
  try {
    return (await client.readContract({
      abi: configAbi,
      address: config,
      args: [key],
      functionName: "getConfigValue",
    })) as Hex
  } catch (error) {
    if (error instanceof BaseError) {
      const revert = error.walk(
        (e) => e instanceof ContractFunctionRevertedError
      )
      if (
        revert instanceof ContractFunctionRevertedError &&
        revert.data?.errorName === "ConfigValueNotSet"
      ) {
        return undefined
      }
    }
    throw error
  }
}

export type BuildCallsInput = {
  allocator: Hex
  assetDecimals: AssetDecimals
  client: ReadClient
  config: Hex
  instance: AtlasInstance
  payloadBuilder: Hex
}

/**
 * Returns the calls whose on-chain state does not already match, Config write
 * first. Throws when an existing value differs or the builder reads another Config.
 */
export const buildConfigureAtlasVmCalls = async ({
  allocator,
  assetDecimals,
  client,
  config,
  instance,
  payloadBuilder,
}: BuildCallsInput): Promise<Call[]> => {
  const { chainId } = instance
  const [allocatorCode, builderCode] = await Promise.all([
    client.getCode({ address: allocator }),
    client.getCode({ address: payloadBuilder }),
  ])
  if (!builderCode || builderCode === "0x") {
    throw new Error(`No code at payload builder ${payloadBuilder}`)
  }
  const allocatorAbis = buildPayloadAbisIn(allocatorCode)
  const builderAbis = buildPayloadAbisIn(builderCode)
  if (allocatorAbis.length !== 1) {
    throw new Error(
      `cannot tell which buildPayload ABI allocator ${allocator} calls (found: ${allocatorAbis.join(", ") || "none"})`
    )
  }
  if (!builderAbis.includes(allocatorAbis[0])) {
    throw new Error(
      `builder ${payloadBuilder} exposes buildPayload(${builderAbis.join("/") || "none"}) but allocator ${allocator} calls buildPayload(${allocatorAbis[0]})`
    )
  }

  const builderConfig = (await client.readContract({
    abi: builderAbi,
    address: payloadBuilder,
    functionName: "CONFIG",
  })) as Hex
  if (getAddress(builderConfig) !== getAddress(config)) {
    throw new Error(
      `Builder ${payloadBuilder} reads Config ${builderConfig}, expected ${config}`
    )
  }

  const entries: {
    key: Hex
    label: string
    replaces?: bigint
    value: bigint
  }[] = [
    {
      key: (await client.readContract({
        abi: builderAbi,
        address: payloadBuilder,
        args: [chainId],
        functionName: "getDomainChainIdKey",
      })) as Hex,
      label: `ATLAS_VM_DOMAIN_CHAIN_ID[${chainId}]`,
      replaces: instance.replacesDomainChainId,
      value: instance.domainChainId,
    },
    {
      key: (await client.readContract({
        abi: builderAbi,
        address: payloadBuilder,
        args: [chainId],
        functionName: "getDomainSaltKey",
      })) as Hex,
      label: `ATLAS_VM_DOMAIN_SALT[${chainId}]`,
      value: BigInt(instance.domainSalt),
    },
    {
      key: (await client.readContract({
        abi: builderAbi,
        address: payloadBuilder,
        args: [chainId],
        functionName: "getExpirationKey",
      })) as Hex,
      label: `ATLAS_VM_EXPIRATION[${chainId}]`,
      value: instance.expirationDelay,
    },
  ]
  for (const asset of instance.assets) {
    const atlasDecimals = assetDecimals.get(Number(BigInt(asset.currency)))
    if (
      atlasDecimals === undefined ||
      BigInt(atlasDecimals) !== asset.decimals
    ) {
      throw new Error(
        `Atlas reports ${atlasDecimals ?? "no"} decimals for ${asset.label}, expected ${asset.decimals}`
      )
    }
    entries.push({
      key: (await client.readContract({
        abi: builderAbi,
        address: payloadBuilder,
        args: [chainId, asset.currency],
        functionName: "getAssetDecimalsKey",
      })) as Hex,
      label: `ATLAS_VM_ASSET_DECIMALS[${chainId}][${asset.label}]`,
      value: asset.decimals,
    })
  }

  const missing: (typeof entries)[number][] = []
  for (const entry of entries) {
    const current = await readConfigValue(client, config, entry.key)
    if (current === undefined) {
      missing.push(entry)
    } else if (BigInt(current) === entry.replaces) {
      missing.push({
        ...entry,
        label: `${entry.label} (replacing ${entry.replaces})`,
      })
    } else if (BigInt(current) !== entry.value) {
      throw new Error(
        `${entry.label} is already ${BigInt(current)}, expected ${entry.value}`
      )
    }
  }

  const calls: Call[] = []
  if (missing.length > 0) {
    calls.push({
      calldata: encodeFunctionData({
        abi: configAbi,
        args: [
          missing.map((entry) => entry.key),
          missing.map((entry) => toHex(entry.value, { size: 32 })),
        ],
        functionName: "setConfigValues",
      }),
      label: `Config.setConfigValues ${missing
        .map((entry) => `${entry.label} = ${entry.value}`)
        .join(", ")}`,
      to: config,
    })
  }

  const encodedDepository = bytesToHex(
    encodeAddress(instance.depository, "atlas-vm")
  )
  const currentBuilder = (await client.readContract({
    abi: allocatorAbi,
    address: allocator,
    args: [chainId, encodedDepository],
    functionName: "payloadBuilders",
  })) as Hex
  const replacing =
    instance.replacesBuilder !== undefined &&
    getAddress(currentBuilder) === getAddress(instance.replacesBuilder)
  if (getAddress(currentBuilder) === ZERO_ADDRESS || replacing) {
    calls.push({
      calldata: encodeFunctionData({
        abi: allocatorAbi,
        args: [chainId, encodedDepository, payloadBuilder],
        functionName: "setPayloadBuilder",
      }),
      label: `RelayAllocator.setPayloadBuilder(${chainId}, ${instance.depository}, ${payloadBuilder})${
        replacing ? ` replacing ${currentBuilder}` : ""
      }`,
      to: allocator,
    })
  } else if (getAddress(currentBuilder) !== getAddress(payloadBuilder)) {
    throw new Error(
      `payloadBuilders[${chainId}][${instance.depository}] is already ${currentBuilder}, expected ${payloadBuilder}`
    )
  }

  return calls
}

const fetchAssetDecimals = async (
  gateway: string,
  apiKey: string
): Promise<AssetDecimals> => {
  const res = await fetch(`${gateway}/market/rpc`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "atlas.getAssets",
      params: {},
    }),
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    method: "POST",
  })
  const body = (await res.json()) as {
    error?: unknown
    result?: { assetId: number; decimals: number }[]
  }
  if (!res.ok || !body.result) {
    throw new Error(
      `atlas.getAssets failed (${res.status}): ${JSON.stringify(body.error)}`
    )
  }
  return new Map(body.result.map((asset) => [asset.assetId, asset.decimals]))
}

const isAddress = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)

const main = async () => {
  const env = process.env.ENV
  const instance =
    env === "dev" || env === "test" ? ATLAS_INSTANCES[env] : undefined
  if (!instance) {
    throw new Error(`ENV must be dev or test (got "${String(env)}")`)
  }
  const apiKey = process.env.ATLAS_API_KEY
  if (!apiKey) {
    throw new Error("Set ATLAS_API_KEY for the Atlas getAssets check")
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
  const payloadBuilder = deploymentFile.payloadBuilders.atlasVmPayloadBuilder
  if (
    !isAddress(allocator) ||
    !isAddress(config) ||
    !isAddress(payloadBuilder)
  ) {
    throw new Error(
      `core.allocator / core.config / payloadBuilders.atlasVmPayloadBuilder missing from contracts/${env}.json`
    )
  }

  // test's Hub runs on Arbitrum Sepolia, dev's on the relay testnet
  const hubChain = env === "test" ? networks["421614"] : relayTestnet
  const rpcUrl = hubChain.rpc[0]
  const client = createPublicClient({ transport: http(rpcUrl) })
  // reads against the wrong chain silently return empty values
  const liveChainId = await client.getChainId()
  if (BigInt(liveChainId) !== hubChain.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${hubChain.chainId}`
    )
  }

  const calls = await buildConfigureAtlasVmCalls({
    allocator,
    assetDecimals: await fetchAssetDecimals(instance.gateway, apiKey),
    client: client as ReadClient,
    config,
    instance,
    payloadBuilder,
  })
  if (calls.length === 0) {
    console.log(`Nothing to do -- ${instance.chainId} is already configured`)
    return
  }

  const owner = (await client.readContract({
    abi: allocatorAbi,
    address: allocator,
    functionName: "owner",
  })) as Hex
  console.log(
    `env: ${env}, chain: ${instance.chainId}, allocator owner: ${owner}`
  )

  // Testnet base fees swing between approval and execution, so test caps at twice the
  // current price with a 1 gwei floor, like the test governance manifests
  const gasPrice = await client.getGasPrice()
  const gasFees =
    env === "test"
      ? {
          maxFeePerGas: (gasPrice * 2n > 10n ** 9n
            ? gasPrice * 2n
            : 10n ** 9n
          ).toString(),
          maxPriorityFeePerGas: "0",
        }
      : RELAY_CHAIN_GAS_CONFIG

  const nonceOffset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  const [baseNonce, gasEstimates] = await Promise.all([
    client
      .getTransactionCount({ address: owner })
      .then((count) => count + nonceOffset),
    // The registration does not depend on the Config write, so both estimate independently.
    Promise.all(
      calls.map((call) =>
        client.estimateGas({ account: owner, data: call.calldata, to: call.to })
      )
    ),
  ])

  const txs = calls.map((call, i) => {
    console.log(`  [nonce ${baseNonce + i}] ${call.label}`)
    return {
      amount: "0",
      calldata: call.calldata,
      family: "ethereum-vm",
      from: owner,
      gas: ((gasEstimates[i] * 110n) / 100n).toString(),
      maxFeePerGas: gasFees.maxFeePerGas,
      maxPriorityFeePerGas: gasFees.maxPriorityFeePerGas,
      nonce: baseNonce + i,
      rpc: rpcUrl,
      to: call.to,
    }
  })

  const path = getManifestPath("configure-atlas-vm", env, env)
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
