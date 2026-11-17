// ABOUTME: Generates a RelayUsdRateLimiter bucket manifest for every origin chain
// ABOUTME: that has fast finality enabled in relay-protocol-oracle.
//
// Usage:
//   ENV=dev yarn workspace @relay-settlement/multisig-tools tsx \
//     scripts/generate-configure-fast-finality-rate-limiter.ts
//   ENV=stag yarn workspace @relay-settlement/multisig-tools tsx \
//     scripts/generate-configure-fast-finality-rate-limiter.ts
//   ENV=prod NONCE_OFFSET=9 yarn workspace @relay-settlement/multisig-tools tsx \
//     scripts/generate-configure-fast-finality-rate-limiter.ts
//
// Production offset snapshot: live Relay nonce 187, with 187-195 reserved by
// manifests 078-080 (PRs #749, #750, #760; Safe nonces 64-66). This produces
// Relay nonce 196. Recheck the live nonce and pending Safe requests before rerunning.
//
// Optional environment variables:
//   RPC_URL       overrides the target relay-chain RPC
//   SIGNER        overrides the environment's security-council signer
//   NONCE_OFFSET  reserves nonce slots already claimed by pending manifests
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { RelayUsdRateLimiter } from "@relay-protocol/settlement-abis"
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseUnits,
} from "viem"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

type Env = "dev" | "stag" | "prod"

const env = process.env.ENV as Env | undefined
if (!env || !["dev", "stag", "prod"].includes(env)) {
  throw new Error(`ENV must be one of dev | stag | prod, got "${env}"`)
}

const CAPACITY = parseUnits("10000", 18)
const RATE = parseUnits("10000", 18)

const SECURITY_COUNCIL_BY_ENV: Record<Env, `0x${string}`> = {
  dev: getAddress("0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"),
  prod: getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A"),
  stag: getAddress("0x71d8bE89D9f2339F0FE9cBA39496C6C9cbFF9da6"),
}

const DEFAULT_RPC_BY_ENV: Record<Env, string> = {
  dev: "https://rpc.testnet.relay.link",
  prod: "https://rpc.chain.relay.link",
  stag: "https://rpc.chain.relay.link",
}

// These ids intentionally match relay-protocol-oracle's chain config keys,
// not numeric EVM chain ids. RelayUsdRateLimiter hashes the raw string.
const CHAIN_IDS_BY_ENV: Record<Env, string[]> = {
  dev: [
    "ethereum",
    "optimism",
    "polygon",
    "abstract",
    "base",
    "arbitrum",
    "solana",
    "bitcoin",
  ],
  prod: [
    "ethereum",
    "optimism",
    "cronos",
    "bnb",
    "gnosis",
    "unichain",
    "polygon",
    "monad",
    "sonic",
    "manta",
    "boba",
    "zksync",
    "shape",
    "worldchain",
    "flow",
    "stable",
    "hyperevm",
    "metis",
    "soneium",
    "ronin",
    "abstract",
    "morph",
    "tempo",
    "megaeth",
    "robinhood",
    "mantle",
    "somnia",
    "arc",
    "b3",
    "base",
    "plasma",
    "apechain",
    "mode",
    "mythos",
    "arbitrum",
    "celo",
    "avalanche",
    "zircuit",
    "ink",
    "linea",
    "bob",
    "berachain",
    "doma",
    "plume",
    "scroll",
    "gensyn",
    "katana",
    "zora",
    "solana",
    "eclipse",
    "bitcoin",
  ],
  stag: [
    "ethereum",
    "optimism",
    "cronos",
    "bnb",
    "gnosis",
    "unichain",
    "polygon",
    "monad",
    "sonic",
    "manta",
    "boba",
    "zksync",
    "shape",
    "worldchain",
    "flow",
    "stable",
    "hyperevm",
    "metis",
    "soneium",
    "ronin",
    "abstract",
    "morph",
    "tempo",
    "megaeth",
    "robinhood",
    "mantle",
    "somnia",
    "arc",
    "b3",
    "base",
    "plasma",
    "apechain",
    "mode",
    "mythos",
    "arbitrum",
    "celo",
    "avalanche",
    "zircuit",
    "ink",
    "linea",
    "bob",
    "berachain",
    "plume",
    "scroll",
    "katana",
    "zora",
    "solana",
    "eclipse",
    "bitcoin",
  ],
}

const main = async () => {
  const deployment = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../contracts/relay-chain/deployments/contracts/${env}.json`
      ),
      "utf8"
    )
  ) as {
    chainId: number
    core: { rateLimiter: { address: string; type: string } }
  }

  if (deployment.core.rateLimiter.type !== "usd") {
    throw new Error(
      `Expected a USD rate limiter for ${env}, got "${deployment.core.rateLimiter.type}"`
    )
  }

  const rateLimiter = getAddress(deployment.core.rateLimiter.address)
  const signer = process.env.SIGNER
    ? getAddress(process.env.SIGNER)
    : SECURITY_COUNCIL_BY_ENV[env]
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_BY_ENV[env]
  const nonceOffset = Number(process.env.NONCE_OFFSET ?? "0")
  if (!Number.isSafeInteger(nonceOffset) || nonceOffset < 0) {
    throw new Error("NONCE_OFFSET must be a non-negative integer")
  }

  const client = createPublicClient({ transport: http(rpcUrl) })
  const liveChainId = await client.getChainId()
  if (liveChainId !== deployment.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${deployment.chainId} for ${env}`
    )
  }

  const bytecode = await client.getCode({ address: rateLimiter })
  if (!bytecode || bytecode === "0x") {
    throw new Error(`No contract deployed at rate limiter ${rateLimiter}`)
  }

  const adminRole = await client.readContract({
    abi: RelayUsdRateLimiter,
    address: rateLimiter,
    functionName: "ADMIN_ROLE",
  })
  const isAdmin = await client.readContract({
    abi: RelayUsdRateLimiter,
    address: rateLimiter,
    args: [adminRole, signer],
    functionName: "hasRole",
  })
  if (!isAdmin) {
    throw new Error(`${signer} does not hold ADMIN_ROLE on ${rateLimiter}`)
  }

  const chainIds = CHAIN_IDS_BY_ENV[env]
  if (new Set(chainIds).size !== chainIds.length) {
    throw new Error(`Duplicate chain id in ${env} bucket configuration`)
  }
  const bucketConfigs = chainIds.map((chainId) => ({
    capacity: CAPACITY,
    chainId,
    isEnabled: true,
    rate: RATE,
  }))
  const calldata = encodeFunctionData({
    abi: RelayUsdRateLimiter,
    args: [bucketConfigs],
    functionName: "setBucketConfigs",
  })

  const [liveNonce, estimatedGas] = await Promise.all([
    client.getTransactionCount({ address: signer }),
    client.estimateGas({
      account: signer,
      data: calldata,
      to: rateLimiter,
    }),
  ])
  const nonce = liveNonce + nonceOffset
  const transactions = [
    {
      amount: "0",
      calldata,
      family: "ethereum-vm",
      from: signer,
      gas: ((estimatedGas * 110n) / 100n).toString(),
      maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
      maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
      nonce,
      rpc: rpcUrl,
      to: rateLimiter,
    },
  ]

  const path = getManifestPath("configure-fast-finality-rate-limiter", env, env)
  writeFileSync(path, `${stringifyJsonWithBigInt(transactions)}\n`)

  console.log(`env: ${env}`)
  console.log(`rate limiter: ${rateLimiter}`)
  console.log(`signer: ${signer}`)
  console.log(`chains: ${chainIds.length}`)
  console.log(`capacity: ${CAPACITY}`)
  console.log(`rate: ${RATE}`)
  console.log(`nonce: ${nonce} (live ${liveNonce} + offset ${nonceOffset})`)
  console.log(`generated: ${path}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
