// ABOUTME: Read-only status check for the INC-13 (Ostium) deposits: for each
// ABOUTME: request id, reports whether the deposit's oracle attestation was
// ABOUTME: executed on the hub and whether the order address holds a balance.
//
// Mirrors the oracle's own derivations (relay-protocol-oracle):
// - idempotency key: sha256("<chainId>:<transactionId>") with the oracle
//   config's chain id string ("arbitrum")
// - credited account: legacy getOrderAddress(chainId, depositor,
//   deposit block timestamp, depositId), token id from the same chain id
import { createHash } from "crypto"
import { createPublicClient, formatEther, http } from "viem"
import { RelayHub } from "@relay-protocol/settlement-abis"
import {
  generateTokenId,
  getOrderAddress,
} from "@relay-protocol/settlement-sdk"
import { networks } from "@relay-protocol/settlement-networks"
import {
  createRelayChainClient,
  RELAY_CHAIN_HUB_ADDRESS,
} from "./helpers/chains"

// Prod oracles. The deposits predate the V2 migration (July 2026), so the
// legacy V1 oracle is checked directly alongside V2 — whose isExecuted()
// delegates to the shared idempotency store and its registered legacy
// sources — in case the V1 source was never registered there.
const ORACLE_V1_ADDRESS = "0xd4b9fdB83C723c096d7fBE72da252aa23f1387aa"
const ORACLE_V2_ADDRESS = "0xd180Dc3b8Cb71b185c563B6e4857592cA93dACAf"

// Chain id string the oracle config uses for Arbitrum One.
const ORACLE_CHAIN_ID = "arbitrum"

const REQUEST_IDS = [
  "0x5b661b1fdf006e2cff0cea588c5e68bc55d500daeb2b7f69ffe8128288e136cc",
  "0x43abb06de5b4a25a2363dbb2fd36cc03b0d9d27e3da49b1aa90e19bfdac3bf6f",
  "0x08e0a2574158b9681c50d19439281f0b1173600a265ac70f94b0634e630a98b2",
  "0xc8645d613395775263ecff798fd20453662d3705c9c1adc9bb866c10e07ab8fe",
  "0xffb855bcc866a5abb048e28301cdd63e4b7ab6efedbfe2e81e0921cbb6ceb97e",
  "0xf1e3a1ac4346bde924128a7b26d81e7d2b58be69a30b413966ba7f369aa6e465",
]

const RELAY_API_URL = "https://api.relay.link/requests/v2"

const oracleAbi = [
  {
    inputs: [{ name: "idempotencyKey", type: "bytes32" }],
    name: "isExecuted",
    outputs: [{ name: "executed", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const

// Mirrors the oracle's getDeterministicId (services/attestation/utils.ts).
const getDeterministicId = (...values: string[]) =>
  `0x${createHash("sha256").update(values.join(":").toLowerCase()).digest("hex")}` as `0x${string}`

const fetchDeposit = async (requestId: string) => {
  const res = await fetch(`${RELAY_API_URL}?id=${requestId}`)
  if (!res.ok) {
    throw new Error(
      `Relay API request failed for ${requestId}: ${res.status} ${await res.text()}`
    )
  }
  const body = (await res.json()) as {
    requests?: {
      protocol?: {
        orderId?: `0x${string}`
        deposit?: {
          origin?: {
            amount: string
            chainId: number
            currency: `0x${string}`
            depositor: `0x${string}`
            transactionId: `0x${string}`
          }
        }
      }
    }[]
  }
  const origin = body.requests?.[0]?.protocol?.deposit?.origin
  const orderId = body.requests?.[0]?.protocol?.orderId
  if (!origin || !orderId) {
    throw new Error(`Relay API returned no deposit data for ${requestId}`)
  }
  return { ...origin, orderId }
}

const main = async () => {
  const { client: relayChainClient } = createRelayChainClient()

  for (const requestId of REQUEST_IDS) {
    const deposit = await fetchDeposit(requestId)

    // Deposit block timestamp from the origin chain (hashed into the order
    // address by the oracle).
    const originRpc = networks[String(deposit.chainId)]?.rpc?.[0]
    if (!originRpc) {
      throw new Error(`No RPC configured for origin chain ${deposit.chainId}`)
    }
    const originClient = createPublicClient({ transport: http(originRpc) })
    const receipt = await originClient.getTransactionReceipt({
      hash: deposit.transactionId,
    })
    const block = await originClient.getBlock({
      blockNumber: receipt.blockNumber,
    })

    const idempotencyKey = getDeterministicId(
      ORACLE_CHAIN_ID,
      deposit.transactionId
    )
    const orderAddress = getOrderAddress({
      chainId: ORACLE_CHAIN_ID,
      depositId: deposit.orderId,
      depositor: deposit.depositor,
      timestamp: block.timestamp,
      vmType: "ethereum-vm",
    })
    const tokenId = generateTokenId({
      address: deposit.currency,
      chainId: ORACLE_CHAIN_ID,
      family: "ethereum-vm",
    })

    const [executedV1, executedV2, balance] = await Promise.all([
      relayChainClient.readContract({
        abi: oracleAbi,
        address: ORACLE_V1_ADDRESS,
        args: [idempotencyKey],
        functionName: "isExecuted",
      }) as Promise<boolean>,
      relayChainClient.readContract({
        abi: oracleAbi,
        address: ORACLE_V2_ADDRESS,
        args: [idempotencyKey],
        functionName: "isExecuted",
      }) as Promise<boolean>,
      relayChainClient.readContract({
        abi: RelayHub,
        address: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
        args: [orderAddress, tokenId],
        functionName: "balanceOf",
      }) as Promise<bigint>,
    ])
    const executed = executedV1 || executedV2

    console.log(`request ${requestId}`)
    console.log(
      `  deposit tx ${deposit.transactionId} | ${formatEther(BigInt(deposit.amount))} ETH from ${deposit.depositor}`
    )
    console.log(`  idempotency key : ${idempotencyKey}`)
    console.log(`  order address   : ${orderAddress}`)
    console.log(
      `  attestation executed on hub : ${executed ? "YES" : "no"} (v1: ${executedV1}, v2/store: ${executedV2}) | order-address balance : ${formatEther(balance)} ETH`
    )
    if (!executed && balance === 0n) {
      console.log(
        "  → never attested: funds sit in the origin depository, not on the hub"
      )
    } else if (executed && balance === 0n) {
      console.log(
        "  → attested AND spent/moved: trace the hub transfers from the order address"
      )
    } else if (executed && balance > 0n) {
      console.log("  → attested and still funded: transferable by the council")
    }
    console.log()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
