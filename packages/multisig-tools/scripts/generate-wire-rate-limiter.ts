// ABOUTME: generates a manifest wiring a deployed rate limiter (amount or usd) into RelayOracleV2
// ABOUTME: (CONSUMER_ROLE + addRateLimiter only — hub/oracle/idempotency roles already exist).
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
} from "viem"
import {
  relay as relayChain,
  relayTestnet,
} from "@relay-protocol/settlement-networks"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

const ENV = (process.env.ENV ?? "prod") as "dev" | "stag" | "prod"

// core.rateLimiter is nested ({address, type}) since multiple limiter kinds exist
// (RelayAmountRateLimiter vs RelayUsdRateLimiter).
const deploymentFile = JSON.parse(
  readFileSync(
    join(
      __dirname,
      `../../../smart-contracts/deployments/contracts/${ENV}.json`
    ),
    "utf8"
  )
) as {
  chainId: number
  core: Record<string, string | { address: string; type: string }>
}
const deployment = deploymentFile.core

// The deployment set decides the chain — a hardcoded mainnet client would
// silently estimate dev's testnet addresses against code-less mainnet slots.
const network = [relayChain, relayTestnet].find(
  (candidate) => candidate.chainId === BigInt(deploymentFile.chainId)
)
if (!network) {
  throw new Error(
    `No relay network configured for chain id ${deploymentFile.chainId}`
  )
}

// Minimal inline ABIs (same pattern as generate-setup-oracle-v2-rate-limiter.ts: the
// published ABI is not yet regenerated with addRateLimiter).
const accessControlAbi = [
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    name: "grantRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

const oracleV2Abi = [
  {
    inputs: [{ name: "rateLimiter", type: "address" }],
    name: "addRateLimiter",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

const role = (name: string) => keccak256(toHex(name))

type Call = { label: string; to: `0x${string}`; calldata: `0x${string}` }

const buildCalls = (): Call[] => {
  const oracle = deployment.oracle as `0x${string}`
  const rateLimiterEntry = deployment.rateLimiter
  const rateLimiter =
    rateLimiterEntry && typeof rateLimiterEntry === "object"
      ? (rateLimiterEntry.address as `0x${string}`)
      : undefined
  if (!rateLimiter || !/^0x[0-9a-fA-F]{40}$/.test(rateLimiter)) {
    throw new Error(
      `deployment.rateLimiter is not a valid {address, type} entry: ${JSON.stringify(rateLimiterEntry)}`
    )
  }

  return [
    {
      calldata: encodeFunctionData({
        abi: accessControlAbi,
        args: [role("CONSUMER_ROLE"), oracle],
        functionName: "grantRole",
      }),
      label: `rateLimiter.grantRole(CONSUMER_ROLE, oracle=${oracle})`,
      to: rateLimiter,
    },
    {
      calldata: encodeFunctionData({
        abi: oracleV2Abi,
        args: [rateLimiter],
        functionName: "addRateLimiter",
      }),
      label: `oracle.addRateLimiter(rateLimiter=${rateLimiter})`,
      to: oracle,
    },
  ]
}

const main = async () => {
  // No derivable default: no config records the signing council (aurora's
  // multisigSigner differs for prod), and a wrong guess bakes in a foreign nonce.
  const signerAddress = process.env.SIGNER as `0x${string}` | undefined
  if (!signerAddress || !/^0x[0-9a-fA-F]{40}$/.test(signerAddress)) {
    throw new Error(
      `SIGNER is required — the council address that signs for "${ENV}" (the "from" of that env's executed manifests under transactions/)`
    )
  }
  console.log(`env: ${ENV}`)
  console.log(`Using signer: ${signerAddress}`)

  const rpcUrl = network.rpc[0]
  const relayChainClient = createPublicClient({ transport: http(rpcUrl) })
  const liveChainId = await relayChainClient.getChainId()
  if (BigInt(liveChainId) !== network.chainId) {
    throw new Error(
      `RPC ${rpcUrl} serves chain ${liveChainId}, expected ${network.chainId}`
    )
  }
  const calls = buildCalls()

  // estimateGas succeeds against a code-less address, yielding a
  // plausible-looking but unusable manifest — refuse instead.
  for (const call of calls) {
    const bytecode = await relayChainClient.getCode({ address: call.to })
    if (!bytecode || bytecode === "0x") {
      throw new Error(`No code at ${call.to} on chain ${liveChainId}`)
    }
  }

  // Nonce fetch has no data dependency on the gas estimates, so run both waves
  // concurrently instead of awaiting the nonce first.
  const [baseNonce, gasEstimates] = await Promise.all([
    relayChainClient.getTransactionCount({ address: signerAddress }),
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
    "wire-rate-limiter",
    `${ENV}-consumer-and-allowlist`
  )
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
