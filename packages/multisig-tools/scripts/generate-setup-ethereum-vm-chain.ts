// ABOUTME: generates the multisig manifest that registers an ethereum-vm chain's
// ABOUTME: depository on the Hub allocator so its deposits can be withdrawn.
//
// A depository on a new EVM chain is unusable until the Hub knows how to build
// withdrawal payloads for it. The allocator looks up
// `payloadBuilders[relayChainId][depository]` and the EthereumVmPayloadBuilder
// reads the chain's numeric EVM chain id from Config; without either, every
// withdrawal from that depository reverts. Both calls are gated on the allocator
// owner (Config resolves its admin from the allocator):
//   1. Config.setConfigValue(ETHEREUM_VM_CHAIN_ID[chain], evmChainId)
//   2. RelayAllocator.setPayloadBuilder(chain, depository, EthereumVmPayloadBuilder)
//
// The Config write is emitted first: the builder reverts with ConfigValueNotSet
// until the chain id exists, so registering it first would fail withdrawals in
// between. Calls whose on-chain state already matches are skipped, and a
// mismatching existing value aborts instead of being silently overwritten.
//
// The relay chain id is the network slug (it must match the oracle's chain id),
// the EVM chain id and depository come from @relay-protocol/settlement-networks,
// and the allocator, Config and builder from
// contracts/relay-chain/deployments/contracts/<env>.json.
//
// Env:
//   ENV    dev | stag | prod (required). dev targets the relay testnet chain
//          (537724); set RPC_537724 when the default endpoint is unavailable.
//   CHAIN  network slug, e.g. megaeth (required).
//   RELAY_NONCE_OFFSET  optional number added to the on-chain nonce, for
//          relay-chain transactions queued in earlier manifests but not yet mined.
//
// Usage:
//   ENV=dev CHAIN=megaeth yarn workspace @relay-settlement/multisig-tools tsx \
//     scripts/generate-setup-ethereum-vm-chain.ts
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  BaseError,
  ContractFunctionRevertedError,
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toBytes,
  toHex,
  type Hex,
} from "viem"
import networks, {
  relay as relayChain,
  relayTestnet,
  type NetworkConfig,
} from "@relay-protocol/settlement-networks"
import { encodeAddress } from "@relay-protocol/settlement-sdk"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

export type Env = "dev" | "stag" | "prod"

export type Call = { calldata: Hex; label: string; to: Hex }

// Only the read surface the generator uses, so tests can pass a plain mock.
export type ReadClient = {
  readContract: (_args: {
    abi: unknown
    address: Hex
    args?: readonly unknown[]
    functionName: string
  }) => Promise<unknown>
}

const configAbi = parseAbi([
  "function getConfigValue(bytes32 key) view returns (bytes32)",
  "function setConfigValue(bytes32 key, bytes32 value)",
  "error ConfigValueNotSet(bytes32 key)",
])

const allocatorAbi = parseAbi([
  "function owner() view returns (address)",
  "function payloadBuilders(string chainId, bytes depository) view returns (address)",
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
])

const ZERO_ADDRESS = `0x${"00".repeat(20)}`

// Must match EthereumVmPayloadBuilder:
// keccak256(abi.encodePacked(keccak256("ETHEREUM_VM_CHAIN_ID"), chainId))
export const ethereumVmChainIdKey = (chainId: string): Hex =>
  keccak256(
    encodePacked(
      ["bytes32", "string"],
      [keccak256(toBytes("ETHEREUM_VM_CHAIN_ID")), chainId]
    )
  )

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
  chainId: string
  client: ReadClient
  config: Hex
  depository: Hex
  evmChainId: bigint
  payloadBuilder: Hex
}

/**
 * Returns the calls whose on-chain state does not already match, Config write
 * first. Throws when an existing value points somewhere else.
 */
export const buildSetupEthereumVmChainCalls = async ({
  allocator,
  chainId,
  client,
  config,
  depository,
  evmChainId,
  payloadBuilder,
}: BuildCallsInput): Promise<Call[]> => {
  const calls: Call[] = []

  const chainIdKey = ethereumVmChainIdKey(chainId)
  const chainIdValue = toHex(evmChainId, { size: 32 })
  const currentChainId = await readConfigValue(client, config, chainIdKey)
  if (currentChainId === undefined) {
    calls.push({
      calldata: encodeFunctionData({
        abi: configAbi,
        args: [chainIdKey, chainIdValue],
        functionName: "setConfigValue",
      }),
      label: `Config.setConfigValue ETHEREUM_VM_CHAIN_ID[${chainId}] = ${evmChainId}`,
      to: config,
    })
  } else if (BigInt(currentChainId) !== evmChainId) {
    throw new Error(
      `ETHEREUM_VM_CHAIN_ID[${chainId}] is already ${BigInt(currentChainId)}, expected ${evmChainId}`
    )
  }

  const encodedDepository = bytesToHex(encodeAddress(depository, "ethereum-vm"))
  const currentBuilder = (await client.readContract({
    abi: allocatorAbi,
    address: allocator,
    args: [chainId, encodedDepository],
    functionName: "payloadBuilders",
  })) as Hex
  if (getAddress(currentBuilder) === ZERO_ADDRESS) {
    calls.push({
      calldata: encodeFunctionData({
        abi: allocatorAbi,
        args: [chainId, encodedDepository, payloadBuilder],
        functionName: "setPayloadBuilder",
      }),
      label: `RelayAllocator.setPayloadBuilder(${chainId}, ${depository}, ${payloadBuilder})`,
      to: allocator,
    })
  } else if (getAddress(currentBuilder) !== getAddress(payloadBuilder)) {
    throw new Error(
      `payloadBuilders[${chainId}][${depository}] is already ${currentBuilder}, expected ${payloadBuilder}`
    )
  }

  return calls
}

const isAddress = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)

const main = async () => {
  const env = process.env.ENV as Env | undefined
  if (env !== "dev" && env !== "stag" && env !== "prod") {
    throw new Error(`ENV must be dev, stag or prod (got "${String(env)}")`)
  }
  const chainId = process.env.CHAIN
  const network = chainId
    ? (networks as Record<string, NetworkConfig>)[chainId]
    : undefined
  if (!chainId || !network || network.slug !== chainId) {
    throw new Error(`CHAIN must be a network slug (got "${String(chainId)}")`)
  }
  if (network.family !== "ethereum-vm") {
    throw new Error(`${chainId} is ${network.family}, not ethereum-vm`)
  }
  const depository = network.contracts?.[env]?.depository
  if (!isAddress(depository)) {
    throw new Error(`No ${env} depository recorded for ${chainId}`)
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
  const payloadBuilder = deploymentFile.payloadBuilders.ethereumVmPayloadBuilder
  if (
    !isAddress(allocator) ||
    !isAddress(config) ||
    !isAddress(payloadBuilder)
  ) {
    throw new Error(
      `core.allocator / core.config / payloadBuilders.ethereumVmPayloadBuilder missing from contracts/${env}.json`
    )
  }

  const chain = env === "dev" ? relayTestnet : relayChain
  const rpcUrl = chain.rpc[0]
  const client = createPublicClient({ transport: http(rpcUrl) })
  // reads against the wrong chain silently return empty values
  const liveChainId = await client.getChainId()
  if (BigInt(liveChainId) !== chain.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${chain.chainId} for env "${env}"`
    )
  }

  const calls = await buildSetupEthereumVmChainCalls({
    allocator,
    chainId,
    client: client as ReadClient,
    config,
    depository,
    evmChainId: network.chainId,
    payloadBuilder,
  })
  if (calls.length === 0) {
    console.log(`Nothing to do -- ${chainId} is already registered on ${env}`)
    return
  }

  const owner = (await client.readContract({
    abi: allocatorAbi,
    address: allocator,
    functionName: "owner",
  })) as Hex
  console.log(`env: ${env}, chain: ${chainId}, allocator owner: ${owner}`)

  const nonceOffset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  const [baseNonce, gasEstimates] = await Promise.all([
    client
      .getTransactionCount({ address: owner })
      .then((count) => count + nonceOffset),
    // Each call is estimated against current state; the builder registration
    // does not depend on the Config write, so both estimate independently.
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
      maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
      maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
      nonce: baseNonce + i,
      rpc: rpcUrl,
      to: call.to,
    }
  })

  const path = getManifestPath(`setup-${chainId}`, env, env)
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
