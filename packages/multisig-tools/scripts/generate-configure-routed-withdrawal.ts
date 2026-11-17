// ABOUTME: generates manifests registering the routed EthereumVmPayloadBuilder and
// ABOUTME: allowlisting its MulticallRouter, per destination chain, on the relay chain.
//
// Both actions are gated on the allocator owner (Config resolves onlyAllocatorOwner from
// the allocator), which is the security council on stag/prod:
//   1. RelayAllocator setPayloadBuilder(chainId, depository, builder)  -- one per chain
//   2. Config        setConfigValues(keys, values)                    -- one batched write
//                      ETHEREUM_VM_CHAIN_ID:<chainId>      (only when missing/stale)
//                      ETHEREUM_VM_ROUTER_ALLOWED:<tuple>  = 1
//
// Ordering is load-bearing: a router allowed while the OLD builder is still registered
// turns a routed withdrawal into a bare transfer to the router, with no revert, leaving
// the funds takeable by anyone. Consecutive nonces cannot enforce this -- a reverted
// registration still consumes its nonce and the config tx would land anyway -- so the
// two actions are split into separate manifests: while any builder registration is
// pending, only the registration manifest is generated; re-run after it executes (the
// on-chain reads then skip the registered builders) to generate the config manifest.
//
// Deploying the router and granting it DEPOSITORY_ROLE happen on the DESTINATION chain
// under the router's own ADMIN_ROLE (generate-grant-router-depository-role.ts), not here,
// and must be done first. The default chain set is every chain with a recorded router.
//
// Env:
//   ROUTER_ROLLOUT_FILE optional JSON with retiredRouters and gatewayDestinations;
//                    added to deployment records routerRollout (see README migration runbook).
//   ENV              dev | stag | prod. Defaults to "prod". dev targets the relay
//                    testnet chain (537724) -- dev privileged changes go through the
//                    multisig flow like stag/prod.
//   CHAINS           optional comma-separated destination chain slugs. Defaults to
//                    every slug under `multicallRouters` in the records file; router per
//                    chain comes from there, depository per chain from settlement-networks.
//   PAYLOAD_BUILDER  optional 0x builder address. Defaults to the env's
//                    payloadBuilders.ethereumVmPayloadBuilder.
//   ALLOWLIST_CHUNK  optional max keys per setConfigValues call (default: all in one).
//                    The relay chain meters sponsored gas per window, so ~50 keys must
//                    go out as several calls of ~10.
//   RELAY_NONCE_OFFSET  optional number added to the on-chain nonce, for relay-chain
//                    transactions queued in earlier manifests but not yet mined.
//   SIGNER           optional 0x signer address to use as `from`. When set, the NEAR/MPC
//                    derivation is skipped.
import { readFileSync, writeFileSync } from "fs"
import {
  assertRetiredRoutersInactive,
  destinationBuilderMismatch,
  destinationDepositoryMismatch,
  loadRouterRollout,
  readConfigWord,
  readDestinationBuilderKey,
  readDestinationDepositoryKey,
  type RouterRollout,
} from "../../../contracts/relay-chain/deployments/scripts/routerRollout"
import { join } from "path"
import {
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  parseAbi,
} from "viem"
import {
  relay as relayChain,
  relayTestnet,
  aurora,
  networks,
} from "@relay-protocol/settlement-networks"
import { encodeAddress } from "@relay-protocol/settlement-sdk"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

const ENV = (process.env.ENV ?? "prod") as "dev" | "stag" | "prod"

// Grouped into core / payloadBuilders since #631; multicallRouters per destination chain.
const deploymentFile = JSON.parse(
  readFileSync(
    join(
      __dirname,
      `../../../contracts/relay-chain/deployments/contracts/${ENV}.json`
    ),
    "utf8"
  )
) as {
  routerRollout?: RouterRollout
  core: Record<string, string>
  multicallRouters?: Record<string, string>
  payloadBuilders: Record<string, string>
}

type DestinationChain = {
  chainId: bigint
  depository: `0x${string}`
  router: `0x${string}`
  slug: string
}

// Each chain costs one ETHEREUM_VM_ROUTER_ALLOWED key, because the key is per
// (chainId, depository, router) even when the router address is identical across chains.
const resolveChains = (): DestinationChain[] =>
  (process.env.CHAINS
    ? process.env.CHAINS.split(",").filter(Boolean)
    : Object.keys(deploymentFile.multicallRouters ?? {})
  ).map((slug) => {
    const net = networks[slug]
    if (!net) throw new Error(`${slug}: not in settlement-networks`)
    const depository = net.contracts?.[ENV]?.depository
    if (!depository || !isAddress(depository)) {
      throw new Error(`${slug}: no ${ENV} depository in settlement-networks`)
    }
    const router = deploymentFile.multicallRouters?.[slug]
    if (!router || !isAddress(router)) {
      throw new Error(
        `${slug}: multicallRouters.${slug} missing from contracts/${ENV}.json`
      )
    }
    return { chainId: net.chainId, depository, router, slug }
  })

const allocatorAbi = parseAbi([
  "function setPayloadBuilder(string chainId, bytes depository, address builder)",
  "function payloadBuilders(string chainId, bytes depository) view returns (address)",
])

// ConfigValueNotSet must be in this ABI: without it viem cannot name the revert, and the
// unset-key path below would fall through to a hard failure.
export const configAbi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
  "function getConfigValue(bytes32 key) view returns (bytes32)",
  "error ConfigValueNotSet(bytes32 key)",
])

// Key derivation lives in the builder as `pure` getters; read them rather than re-deriving
// here so the manifest cannot drift from the contract.
const payloadBuilderAbi = parseAbi([
  "function getEvmChainIdKey(string chainId) view returns (bytes32)",
  "function getRouterAllowedKey(string chainId, address depository, address router) view returns (bytes32)",
])

type Call = { calldata: `0x${string}`; label: string; to: `0x${string}` }

const requireAddressEnv = (name: string): `0x${string}` => {
  const value = process.env[name]
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is not a valid address: ${String(value)}`)
  }
  return value as `0x${string}`
}

const uint256Word = (value: bigint): `0x${string}` =>
  `0x${value.toString(16).padStart(64, "0")}`

const readConfigValue = readConfigWord

export const buildCalls = async (
  client: ReturnType<typeof createPublicClient>,
  payloadBuilder: `0x${string}`,
  chains: DestinationChain[],
  records = deploymentFile
): Promise<{ builderCalls: Call[]; configCalls: Call[] }> => {
  const allocator = records.core.allocator as `0x${string}`
  const config = records.core.config as `0x${string}`

  const rollout = loadRouterRollout(records.routerRollout)
  assertRetiredRoutersInactive(rollout, records.multicallRouters, ENV)
  const gatewayBuilder = records.payloadBuilders.gatewayVmPayloadBuilder
  const destinationBuilder =
    records.payloadBuilders.gatewayEthereumVmDestinationPayloadBuilder
  if (
    rollout.gatewayDestinations.length > 0 &&
    (!gatewayBuilder ||
      !isAddress(gatewayBuilder) ||
      !destinationBuilder ||
      !isAddress(destinationBuilder))
  ) {
    throw new Error(
      `payloadBuilders.gatewayVmPayloadBuilder and gatewayEthereumVmDestinationPayloadBuilder missing from contracts/${ENV}.json`
    )
  }
  for (const chain of chains) {
    if (
      rollout.retiredRouters.some(
        (old) =>
          old.chain === chain.slug &&
          old.depository.toLowerCase() === chain.depository.toLowerCase() &&
          old.router.toLowerCase() === chain.router.toLowerCase()
      )
    ) {
      throw new Error("Router tuple cannot be both active and retired")
    }
  }
  const builderCalls: Call[] = []
  const configCalls: Call[] = []
  const keys: `0x${string}`[] = []
  const values: `0x${string}`[] = []

  const push = async (
    key: `0x${string}`,
    value: `0x${string}`,
    label: string
  ) => {
    const existing = keys.indexOf(key)
    if (existing >= 0) {
      if (values[existing] !== value)
        throw new Error(`Conflicting config writes for ${key}`)
      return
    }
    const current = await readConfigValue(client, config, key)
    if (current?.toLowerCase() === value.toLowerCase()) {
      console.log(`  [skip] ${label} already set`)
      return
    }
    console.log(`  [set ] ${label} key=${key} value=${value}`)
    keys.push(key)
    values.push(value)
  }

  for (const chain of chains) {
    const depositoryEncoded = bytesToHex(
      encodeAddress(chain.depository, "ethereum-vm")
    )
    const registered = (await client.readContract({
      abi: allocatorAbi,
      address: allocator,
      args: [chain.slug, depositoryEncoded],
      functionName: "payloadBuilders",
    })) as `0x${string}`

    if (registered.toLowerCase() === payloadBuilder.toLowerCase()) {
      console.log(`  [skip] ${chain.slug} builder already registered`)
    } else {
      builderCalls.push({
        calldata: encodeFunctionData({
          abi: allocatorAbi,
          args: [chain.slug, depositoryEncoded, payloadBuilder],
          functionName: "setPayloadBuilder",
        }),
        label: `allocator.setPayloadBuilder(${chain.slug}, ${chain.depository}, ${payloadBuilder}) [was ${registered}]`,
        to: allocator,
      })
    }

    const chainIdKey = (await client.readContract({
      abi: payloadBuilderAbi,
      address: payloadBuilder,
      args: [chain.slug],
      functionName: "getEvmChainIdKey",
    })) as `0x${string}`
    await push(
      chainIdKey,
      uint256Word(chain.chainId),
      `${chain.slug} signatureChainId=${chain.chainId}`
    )

    const routerKey = (await client.readContract({
      abi: payloadBuilderAbi,
      address: payloadBuilder,
      args: [chain.slug, chain.depository, chain.router],
      functionName: "getRouterAllowedKey",
    })) as `0x${string}`
    await push(
      routerKey,
      uint256Word(1n),
      `${chain.slug} routerAllowed router=${chain.router}`
    )
  }

  for (const [tuples, value] of [
    [rollout.retiredRouters, 0n],
    [rollout.gatewayDestinations, 1n],
  ] as const) {
    for (const tuple of tuples) {
      if (value === 1n) {
        const chainKey = (await client.readContract({
          abi: payloadBuilderAbi,
          address: payloadBuilder,
          args: [tuple.chain],
          functionName: "getEvmChainIdKey",
        })) as `0x${string}`
        await push(
          chainKey,
          uint256Word(networks[tuple.chain].chainId),
          `${tuple.chain} Gateway signatureChainId`
        )
      }
      const key = (await client.readContract({
        abi: payloadBuilderAbi,
        address: payloadBuilder,
        args: [tuple.chain, tuple.depository, tuple.router],
        functionName: "getRouterAllowedKey",
      })) as `0x${string}`
      const label = `${tuple.chain} depository=${tuple.depository} router=${tuple.router} allowed=${value}`
      if (value === 1n) {
        // Same gate as the ordinary builder registration: allowlisting a Gateway
        // router behind another destination builder turns routed withdrawals
        // into bare transfers, so hold the write until the builder is configured.
        const mismatch = destinationBuilderMismatch(
          await readConfigValue(
            client,
            config,
            await readDestinationBuilderKey(
              client,
              gatewayBuilder as `0x${string}`,
              tuple.chain
            )
          ),
          destinationBuilder as `0x${string}`
        )
        if (mismatch) {
          console.log(
            `  [hold] ${label} withheld: ${mismatch} -- configure the Gateway destination builder, then re-run`
          )
          continue
        }
        // The recorded depository receives DEPOSITORY_ROLE on the router, so it must
        // be the one Config resolves: unset means the destination is not activated
        // yet (hold), another address means the record is wrong (abort).
        const configuredDepository = await readConfigValue(
          client,
          config,
          await readDestinationDepositoryKey(
            client,
            gatewayBuilder as `0x${string}`,
            tuple.chain
          )
        )
        const depositoryMismatch = destinationDepositoryMismatch(
          configuredDepository,
          tuple.depository
        )
        if (depositoryMismatch && configuredDepository === undefined) {
          console.log(
            `  [hold] ${label} withheld: ${depositoryMismatch} -- activate the Gateway destination, then re-run`
          )
          continue
        }
        if (depositoryMismatch) {
          throw new Error(`${tuple.chain}: ${depositoryMismatch}`)
        }
      }
      await push(key, uint256Word(value), label)
    }
  }

  const chunk =
    Number(process.env.ALLOWLIST_CHUNK ?? keys.length) || keys.length
  for (let i = 0; i < keys.length; i += chunk) {
    const chunkKeys = keys.slice(i, i + chunk)
    configCalls.push({
      calldata: encodeFunctionData({
        abi: configAbi,
        args: [chunkKeys, values.slice(i, i + chunk)],
        functionName: "setConfigValues",
      }),
      label: `config.setConfigValues(${chunkKeys.length} keys${keys.length > chunk ? `, ${i / chunk + 1}/${Math.ceil(keys.length / chunk)}` : ""})`,
      to: config,
    })
  }

  return { builderCalls, configCalls }
}

const main = async () => {
  if (ENV !== "dev" && ENV !== "stag" && ENV !== "prod") {
    throw new Error(`ENV must be dev, stag or prod (got "${ENV}")`)
  }

  const payloadBuilder = process.env.PAYLOAD_BUILDER
    ? requireAddressEnv("PAYLOAD_BUILDER")
    : (deploymentFile.payloadBuilders.ethereumVmPayloadBuilder as `0x${string}`)
  if (!/^0x[0-9a-fA-F]{40}$/.test(payloadBuilder)) {
    throw new Error(
      `payloadBuilders.ethereumVmPayloadBuilder missing from contracts/${ENV}.json`
    )
  }

  let signerAddress = process.env.SIGNER as `0x${string}` | undefined
  if (signerAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(signerAddress)) {
      throw new Error(`SIGNER is not a valid address: ${signerAddress}`)
    }
  } else {
    const multisigSigner = aurora.contracts?.[ENV]?.multisigSigner
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
  console.log(`env: ${ENV}`)
  console.log(`Using signer from MPC : ${signerAddress}`)

  const chain = ENV === "dev" ? relayTestnet : relayChain
  const rpcUrl = chain.rpc[0]
  const relayChainClient = createPublicClient({ transport: http(rpcUrl) })
  // reads against the wrong chain silently return empty values
  const liveChainId = await relayChainClient.getChainId()
  if (BigInt(liveChainId) !== chain.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${chain.chainId} for env "${ENV}"`
    )
  }

  // Every key read goes through the builder, so an undeployed address would surface as a
  // pile of unrelated reverts.
  const builderCode = await relayChainClient.getCode({
    address: payloadBuilder,
  })
  if (!builderCode || builderCode === "0x") {
    throw new Error(
      `PAYLOAD_BUILDER ${payloadBuilder} has no code on the relay chain -- deploy it first (deploying is permissionless)`
    )
  }
  const { builderCalls, configCalls } = await buildCalls(
    relayChainClient,
    payloadBuilder,
    resolveChains()
  )
  if (builderCalls.length === 0 && configCalls.length === 0) {
    console.log("Nothing to do -- builder and config already match")
    return
  }

  // A reverted registration still consumes its nonce, so bundling the config write
  // behind it in one manifest cannot guarantee ordering. Emit the registration manifest
  // alone and hold the config manifest until a re-run confirms the builders on-chain.
  const calls = builderCalls.length > 0 ? builderCalls : configCalls
  const phase =
    builderCalls.length > 0 ? "builder-registration" : "router-allowlist"
  if (builderCalls.length > 0 && configCalls.length > 0) {
    console.log(
      "  [hold] config manifest withheld until the builder registrations are on-chain -- execute this manifest, then re-run"
    )
  }

  // Nonce fetch has no data dependency on the gas estimates, so run both waves
  // concurrently instead of awaiting the nonce first.
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

  const path = getManifestPath(
    "configure-routed-withdrawal",
    `${ENV}-${phase}`,
    ENV
  )
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
