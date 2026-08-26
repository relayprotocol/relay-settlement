// ABOUTME generate a manifest that adds or replaces RelayPriceOracle feed
// routes, to be submitted through RelayMultisigSigner. Encodes a single
// setFeedRoutes batch call against the oracle recorded in the target env's
// deployment file.
//
// Env:
//   ENV      deployment env to target (dev | stag | prod). Required.
//   SIGNER   optional 0x signer address to use as `from`. When set, the
//            NEAR/MPC derivation is skipped. Use this when the oracle owner
//            differs from the env's own MPC wallet (e.g. the dev oracle is
//            currently owned by the stag MPC wallet).
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { createPublicClient, encodeFunctionData, http } from "viem"
import {
  relay as relayChain,
  relayTestnet,
  aurora,
} from "@relay-protocol/settlement-networks"
import { RelayPriceOracle } from "@relay-protocol/settlement-abis"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

const ENV = process.env.ENV as "dev" | "stag" | "prod" | undefined
if (!ENV || !["dev", "stag", "prod"].includes(ENV)) {
  throw new Error(`ENV must be one of dev | stag | prod, got "${ENV}"`)
}

const STORK_PROVIDER_ID =
  "0x477a6446c896dd7534f801b64251153885069a0bb95a959ddbdb23b8e23c18d1"

type FeedRoute = {
  label: string
  currency: { chainId: string; currency: `0x${string}` }
  providerId: `0x${string}`
  feedId: `0x${string}`
  currencyDecimals: number
  maxAgeSeconds: number
}

// Stork fast feed ids are keccak256(uint16 taxonomyId, uint16 assetId),
// matching crates/stork-ingester definition.
const routes: FeedRoute[] = [
  {
    currency: {
      chainId: "tron",
      currency: "0x410000000000000000000000000000000000000000",
    },
    currencyDecimals: 6,
    feedId:
      "0x07d6091d6a6d10897d8286f809028723cb113cce9a9db90764dec9a811ee2973",
    label: "TRX",
    maxAgeSeconds: 30,
    providerId: STORK_PROVIDER_ID,
  },
  {
    currency: {
      chainId: "ton",
      currency:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
    currencyDecimals: 9,
    feedId:
      "0x455a57bbafe330e1bf2bd701f8fc2e81af56b94bdbcde894895b254ff4225d23",
    label: "TON",
    maxAgeSeconds: 30,
    providerId: STORK_PROVIDER_ID,
  },
]

const main = async () => {
  const deployment = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../smart-contracts/deployments/contracts/${ENV}.json`
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
  const rpcUrl = chain.rpc[0]
  const client = createPublicClient({ transport: http(rpcUrl) })

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

  const [nonce, gas] = await Promise.all([
    client.getTransactionCount({ address: signerAddress }),
    client.estimateGas({
      account: signerAddress,
      data: calldata,
      to: priceOracle,
    }),
  ])

  const labels = routes.map((r) => r.label).join("-")
  console.log(`setFeedRoutes: ${labels} [nonce ${nonce}]`)

  const manifestName = routes
    .slice(0, 10)
    .map((r) => r.label)
    .join("-")

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
      to: priceOracle,
    },
  ]

  const path = getManifestPath("set-feed-routes", manifestName, ENV)
  writeFileSync(path, `${stringifyJsonWithBigInt(txs)}\n`)

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
