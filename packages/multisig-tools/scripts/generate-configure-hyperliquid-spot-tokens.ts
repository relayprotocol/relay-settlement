// ABOUTME: generates the relay-chain manifest seeding Config with the Hyperliquid spot-token
// ABOUTME: metadata (symbol, decimals, dexes) HyperliquidVmPayloadBuilder reads for sendAsset.
//
// An unconfigured spot token reverts ConfigValueNotSet and strands its hub balance. Symbol and
// decimals are checked against Hyperliquid spotMeta, whose szDecimals the oracle attests in.
//
// Env:
//   ENV                 dev | stag | prod. Required.
//   SIGNER              optional 0x signer address to use as `from`. When set, the
//                       NEAR/MPC derivation is skipped.
//   RELAY_NONCE_OFFSET  optional number added to the on-chain nonce, for relay-chain
//                       transactions queued in earlier manifests but not yet mined.
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  stringToHex,
  toHex,
} from "viem"
import {
  relay as relayChain,
  relayTestnet,
  aurora,
} from "@relay-protocol/settlement-networks"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

const ENV = process.env.ENV as "dev" | "stag" | "prod" | undefined
if (!ENV || !["dev", "stag", "prod"].includes(ENV)) {
  throw new Error(`ENV must be one of dev | stag | prod, got "${ENV}"`)
}

// Relay chain id the allocator keys the Hyperliquid builder on.
const HYPERLIQUID_CHAIN_ID = "hyperliquid"

type SpotToken = {
  // 16-byte Hyperliquid spot token id, as the hub encodes the currency
  currency: `0x${string}`
  symbol: string
  // Hyperliquid szDecimals for the token
  targetDecimals: number
}

// Spot tokens move spot -> spot; native perp USDC takes the usdSend path instead.
const SPOT_TOKENS: SpotToken[] = [
  {
    currency: "0x0d01dc56dcaaca66ad901c959b4011ec",
    symbol: "HYPE",
    targetDecimals: 2,
  },
]
const SOURCE_DEX = "spot"
const DESTINATION_DEX = "spot"

// Keyed by the builder's hyperliquidChain(), which names the Hyperliquid environment.
const HYPERLIQUID_INFO_URL: Record<string, string> = {
  Mainnet: "https://api.hyperliquid.xyz/info",
  Testnet: "https://api.hyperliquid-testnet.xyz/info",
}

const deploymentFile = JSON.parse(
  readFileSync(
    join(
      __dirname,
      `../../../smart-contracts/deployments/contracts/${ENV}.json`
    ),
    "utf8"
  )
) as { core: Record<string, string>; payloadBuilders: Record<string, string> }

// ConfigValueNotSet must be in this ABI so viem can name the revert on unset keys.
const configAbi = parseAbi([
  "function setConfigValues(bytes32[] keys, bytes32[] values)",
  "function getConfigValue(bytes32 key) view returns (bytes32)",
  "error ConfigValueNotSet(bytes32 key)",
])

// Key derivation lives in the builder as `pure` getters; read them rather than re-deriving
// here so the manifest cannot drift from the contract.
const payloadBuilderAbi = parseAbi([
  "function hyperliquidChain() view returns (string)",
  "function getCurrencySymbolKey(string chainId, bytes currency) view returns (bytes32)",
  "function getTargetDecimalsKey(string chainId, bytes currency) view returns (bytes32)",
  "function getSourceDexKey(string chainId, bytes currency) view returns (bytes32)",
  "function getDestinationDexKey(string chainId, bytes currency) view returns (bytes32)",
])

type SpotMeta = {
  tokens: { name: string; szDecimals: number; tokenId: string }[]
}

const requireAddress = (value: string, name: string): `0x${string}` => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is not a valid address: ${String(value)}`)
  }
  return value as `0x${string}`
}

const uint256Word = (value: bigint): `0x${string}` => toHex(value, { size: 32 })
const bytes32String = (value: string): `0x${string}` => {
  if (Buffer.byteLength(value, "utf8") > 32) {
    throw new Error(`"${value}" does not fit in bytes32`)
  }
  return stringToHex(value, { size: 32 })
}

const readConfigValue = async (
  client: ReturnType<typeof createPublicClient>,
  config: `0x${string}`,
  key: `0x${string}`
): Promise<`0x${string}` | undefined> => {
  try {
    return (await client.readContract({
      abi: configAbi,
      address: config,
      args: [key],
      functionName: "getConfigValue",
    })) as `0x${string}`
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

const fetchSpotMeta = async (infoUrl: string): Promise<SpotMeta> => {
  const response = await fetch(infoUrl, {
    body: JSON.stringify({ type: "spotMeta" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  })
  if (!response.ok) {
    throw new Error(`spotMeta request failed: ${response.status}`)
  }
  return (await response.json()) as SpotMeta
}

const main = async () => {
  const config = requireAddress(deploymentFile.core.config, "core.config")
  const payloadBuilder = requireAddress(
    deploymentFile.payloadBuilders.hyperliquidVmPayloadBuilder,
    "payloadBuilders.hyperliquidVmPayloadBuilder"
  )

  let signerAddress = process.env.SIGNER as `0x${string}` | undefined
  if (signerAddress) {
    signerAddress = requireAddress(signerAddress, "SIGNER")
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
  console.log(`config: ${config}`)
  console.log(`payload builder: ${payloadBuilder}`)
  console.log(`signer (from): ${signerAddress}`)

  const chain = ENV === "dev" ? relayTestnet : relayChain
  const rpcUrl = chain.rpc[0]
  const client = createPublicClient({ transport: http(rpcUrl) })
  // reads against the wrong chain silently return empty values
  const liveChainId = await client.getChainId()
  if (BigInt(liveChainId) !== chain.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${chain.chainId} for env "${ENV}"`
    )
  }

  const hyperliquidChain = (await client.readContract({
    abi: payloadBuilderAbi,
    address: payloadBuilder,
    functionName: "hyperliquidChain",
  })) as string
  const infoUrl = HYPERLIQUID_INFO_URL[hyperliquidChain]
  if (!infoUrl) {
    throw new Error(`Unknown hyperliquidChain "${hyperliquidChain}"`)
  }
  const spotMeta = await fetchSpotMeta(infoUrl)
  const metaByTokenId = new Map(
    spotMeta.tokens.map((token) => [token.tokenId.toLowerCase(), token])
  )
  console.log(
    `hyperliquid: ${hyperliquidChain} (${spotMeta.tokens.length} spot tokens)`
  )

  const keys: `0x${string}`[] = []
  const values: `0x${string}`[] = []
  const push = async (
    key: `0x${string}`,
    value: `0x${string}`,
    label: string
  ) => {
    const current = await readConfigValue(client, config, key)
    if (current?.toLowerCase() === value.toLowerCase()) {
      console.log(`  [skip] ${label} already set`)
      return
    }
    console.log(`  [set ] ${label} key=${key} value=${value}`)
    keys.push(key)
    values.push(value)
  }

  for (const token of SPOT_TOKENS) {
    const meta = metaByTokenId.get(token.currency.toLowerCase())
    if (!meta) {
      throw new Error(`${token.symbol}: ${token.currency} not in spotMeta`)
    }
    if (
      meta.name !== token.symbol ||
      meta.szDecimals !== token.targetDecimals
    ) {
      throw new Error(
        `${token.symbol}: spotMeta says ${meta.name} with szDecimals ${meta.szDecimals}, table has ${token.targetDecimals}`
      )
    }

    const keyArgs = [HYPERLIQUID_CHAIN_ID, token.currency] as const
    const [symbolKey, decimalsKey, sourceDexKey, destinationDexKey] =
      (await Promise.all(
        (
          [
            "getCurrencySymbolKey",
            "getTargetDecimalsKey",
            "getSourceDexKey",
            "getDestinationDexKey",
          ] as const
        ).map((functionName) =>
          client.readContract({
            abi: payloadBuilderAbi,
            address: payloadBuilder,
            args: keyArgs,
            functionName,
          })
        )
      )) as `0x${string}`[]

    await push(symbolKey, bytes32String(token.symbol), `${token.symbol} symbol`)
    await push(
      decimalsKey,
      uint256Word(BigInt(token.targetDecimals)),
      `${token.symbol} targetDecimals=${token.targetDecimals}`
    )
    await push(
      sourceDexKey,
      bytes32String(SOURCE_DEX),
      `${token.symbol} sourceDex=${SOURCE_DEX}`
    )
    await push(
      destinationDexKey,
      bytes32String(DESTINATION_DEX),
      `${token.symbol} destinationDex=${DESTINATION_DEX}`
    )
  }

  if (keys.length === 0) {
    console.log("Nothing to do -- every key already holds its value")
    return
  }

  const calldata = encodeFunctionData({
    abi: configAbi,
    args: [keys, values],
    functionName: "setConfigValues",
  })
  const nonceOffset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  const [onChainNonce, gas] = await Promise.all([
    client.getTransactionCount({ address: signerAddress }),
    client.estimateGas({
      account: signerAddress,
      data: calldata,
      to: config,
    }),
  ])
  const nonce = onChainNonce + nonceOffset
  console.log(`  [nonce ${nonce}] config.setConfigValues(${keys.length} keys)`)

  const txs = [
    {
      amount: "0",
      calldata,
      family: "ethereum-vm",
      from: signerAddress,
      gas: ((gas * 110n) / 100n).toString(),
      maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
      maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
      nonce,
      rpc: rpcUrl,
      to: config,
    },
  ]

  const path = getManifestPath(
    "configure-hyperliquid-spot-tokens",
    SPOT_TOKENS.map((token) => token.symbol).join("-"),
    ENV
  )
  writeFileSync(path, `${stringifyJsonWithBigInt(txs)}\n`)

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
