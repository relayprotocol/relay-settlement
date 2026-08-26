// ABOUTME: Executes the INC-13 (Ostium) deposit attestations on the hub:
// ABOUTME: fetches quorum-signed executions from the oracle API and
// ABOUTME: broadcasts them, minting each frozen deposit to its order address.
//
// This is step 1 of the INC-13 recovery: it settles the deposits exactly as
// the protocol would have (consuming the oracle idempotency keys, so the
// attestations cannot double-credit later). Step 2 is the council manifest
// from generate-inc13-recovery-transfers.ts, which moves the order-address
// balances to the recovery Safe.
//
// Env:
//   ORACLE_API_URL        oracle base url (e.g. the prod oracle service)
//   ORACLE_API_KEY        optional x-api-key for the oracle
//   DEPLOYER_PRIVATE_KEY  key broadcasting on the relay chain (needs gas and
//                         relay-chain send permission)
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  defineChain,
  formatEther,
  http,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { RelayHub } from "@relay-protocol/settlement-abis"
import { relay as relayChain } from "@relay-protocol/settlement-networks"
import {
  RELAY_CHAIN_HUB_ADDRESS,
  RELAY_CHAIN_GAS_CONFIG,
} from "./helpers/chains"

// Prod oracle V2 and its multisig (EIP-1271 validator for aggregated
// signatures), per the oracle service's hub.mainnets.prod.json.
const ORACLE_V2_ADDRESS = "0xd180Dc3b8Cb71b185c563B6e4857592cA93dACAf"
const ORACLE_MULTISIG_ADDRESS = "0x2A72EB8Cf0233A3DC6198683c83B1078DE6Fa2B0"
const RELAY_EVM_CHAIN_ID = 537713

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
    inputs: [
      {
        components: [
          { name: "idempotencyKey", type: "bytes32" },
          { name: "actions", type: "bytes[]" },
        ],
        name: "execution",
        type: "tuple",
      },
      { name: "oracle", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "idempotencyKey", type: "bytes32" }],
    name: "isExecuted",
    outputs: [{ name: "executed", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const

type OracleExecution = {
  idempotencyKey: `0x${string}`
  actions: `0x${string}`[]
  signatures: {
    oracleChainId: string
    oracleContract: string
    oracleSigner: string
    signature: `0x${string}`
  }[]
}

const fetchDepositTx = async (requestId: string) => {
  const res = await fetch(`${RELAY_API_URL}?id=${requestId}`)
  if (!res.ok) {
    throw new Error(
      `Relay API request failed for ${requestId}: ${res.status} ${await res.text()}`
    )
  }
  const body = (await res.json()) as {
    requests?: {
      protocol?: {
        deposit?: { origin?: { transactionId: `0x${string}` } }
      }
    }[]
  }
  const transactionId =
    body.requests?.[0]?.protocol?.deposit?.origin?.transactionId
  if (!transactionId) {
    throw new Error(`Relay API returned no deposit tx for ${requestId}`)
  }
  return transactionId
}

const fetchAttestation = async (
  oracleApiUrl: string,
  transactionId: `0x${string}`
): Promise<OracleExecution> => {
  const res = await fetch(
    `${oracleApiUrl}/attestations/depository-deposits/v1`,
    {
      body: JSON.stringify({
        chainId: ORACLE_CHAIN_ID,
        requestPeerSignatures: true,
        transactionId,
      }),
      headers: {
        "Content-Type": "application/json",
        ...(process.env.ORACLE_API_KEY
          ? { "x-api-key": process.env.ORACLE_API_KEY }
          : {}),
      },
      method: "POST",
    }
  )
  if (!res.ok) {
    throw new Error(
      `Oracle attestation failed for ${transactionId}: ${res.status} ${await res.text()}`
    )
  }
  const body = (await res.json()) as { execution?: OracleExecution }
  if (!body.execution) {
    throw new Error(`Oracle returned no execution for ${transactionId}`)
  }
  return body.execution
}

// Aggregate the peer signatures for the oracle multisig's EIP-1271
// validation: keep signatures for our oracle contract, sort by signer
// address, and concatenate — mirrors the solver's handling.
const aggregateSignature = (execution: OracleExecution) => {
  const valid = execution.signatures.filter(
    (s) =>
      Number(s.oracleChainId) === RELAY_EVM_CHAIN_ID &&
      s.oracleContract.toLowerCase() === ORACLE_V2_ADDRESS.toLowerCase()
  )
  if (valid.length === 0) {
    throw new Error(
      `No signatures for oracle ${ORACLE_V2_ADDRESS} in attestation ${execution.idempotencyKey}`
    )
  }
  console.log(
    `  signers: ${valid.map((s) => s.oracleSigner).join(", ")} (${valid.length} signature(s))`
  )
  return ("0x" +
    valid
      .sort((a, b) =>
        BigInt(a.oracleSigner) <= BigInt(b.oracleSigner) ? -1 : 1
      )
      .map((s) => s.signature.slice(2))
      .join("")) as `0x${string}`
}

const main = async () => {
  const oracleApiUrl = process.env.ORACLE_API_URL
  if (!oracleApiUrl) {
    throw new Error("Set ORACLE_API_URL in the environment")
  }
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY
  if (!privateKey) {
    throw new Error("Set DEPLOYER_PRIVATE_KEY in the environment")
  }
  const account = privateKeyToAccount(
    (privateKey.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`) as `0x${string}`
  )

  const rpcUrl = relayChain.rpc[0]
  const chain = defineChain({
    id: RELAY_EVM_CHAIN_ID,
    name: "Relay Chain",
    nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  })

  console.log(`Broadcasting from ${account.address} via ${rpcUrl}\n`)

  for (const requestId of REQUEST_IDS) {
    console.log(`request ${requestId}`)
    const transactionId = await fetchDepositTx(requestId)
    const execution = await fetchAttestation(oracleApiUrl, transactionId)

    const alreadyExecuted = (await publicClient.readContract({
      abi: oracleAbi,
      address: ORACLE_V2_ADDRESS,
      args: [execution.idempotencyKey],
      functionName: "isExecuted",
    })) as boolean
    if (alreadyExecuted) {
      console.log(
        `  already executed (key ${execution.idempotencyKey}), skipping\n`
      )
      continue
    }

    // Report what the execution mints so the broadcast is reviewable.
    for (const action of execution.actions) {
      const [actionType, hubToAddress, hubTokenId, amount] =
        decodeAbiParameters(
          [
            { name: "actionType", type: "uint8" },
            { name: "hubToAddress", type: "address" },
            { name: "hubTokenId", type: "uint256" },
            { name: "amount", type: "uint256" },
          ],
          action
        )
      console.log(
        `  action: type ${actionType} -> mint ${formatEther(amount)} of id ${hubTokenId} to ${hubToAddress}`
      )
    }

    const signature = aggregateSignature(execution)

    // execute() (not executeMultiple) so a signature/threshold problem
    // reverts loudly instead of being swallowed as an ExecutionFailed event.
    const hash = await walletClient.writeContract({
      abi: oracleAbi,
      address: ORACLE_V2_ADDRESS,
      args: [
        {
          actions: execution.actions,
          idempotencyKey: execution.idempotencyKey,
        },
        ORACLE_MULTISIG_ADDRESS,
        signature,
      ],
      functionName: "execute",
      maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
      maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
    })
    console.log(`  execute tx: ${hash}`)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log(
      `  confirmed in block ${receipt.blockNumber} (${receipt.status})`
    )

    // Verify the mint landed where the action said it would.
    const [, hubToAddress, hubTokenId] = decodeAbiParameters(
      [
        { name: "actionType", type: "uint8" },
        { name: "hubToAddress", type: "address" },
        { name: "hubTokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
      ],
      execution.actions[0]
    )
    const balance = (await publicClient.readContract({
      abi: RelayHub,
      address: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
      args: [hubToAddress, hubTokenId],
      functionName: "balanceOf",
    })) as bigint
    console.log(
      `  order address ${hubToAddress} balance: ${formatEther(balance)}\n`
    )
  }

  console.log(
    "Done. Run check-inc13-attestations.ts to verify all keys are consumed, then generate the council transfer manifest."
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
