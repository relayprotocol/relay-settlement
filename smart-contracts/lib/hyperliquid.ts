import { decodeAbiParameters } from "viem"

// Define Hyperliquid transaction types
export const HYPERLIQUID_TX_ABI = [
  {
    components: [
      { name: "txType", type: "uint8" },
      { name: "parameters", type: "bytes" },
    ],
    type: "tuple",
  },
] as const

export const USD_SEND_REQUEST_ABI = [
  {
    components: [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
    type: "tuple",
  },
] as const

export const SPOT_SEND_REQUEST_ABI = [
  {
    components: [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "token", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
    type: "tuple",
  },
] as const

// Type definitions
export type HyperliquidTxType = "UsdSend" | "SpotSend"

export interface UsdSendRequest {
  hyperliquidChain: string
  destination: string
  amount: string
  time: bigint
}

export interface SpotSendRequest {
  hyperliquidChain: string
  destination: string
  token: string
  amount: string
  time: bigint
}

export interface HyperliquidTx {
  txType: number
  parameters: `0x${string}`
}

/**
 * Decode a Hyperliquid transaction payload
 * @param encoded The encoded payload
 * @returns Decoded transaction with type and request data
 */
export function decodeHyperliquidPayload(encoded: `0x${string}`) {
  const [decodedPayload] = decodeAbiParameters(HYPERLIQUID_TX_ABI, encoded)

  if (decodedPayload.txType === 0) {
    // USD Send
    const [request] = decodeAbiParameters(
      USD_SEND_REQUEST_ABI,
      decodedPayload.parameters
    )
    return {
      request: request as UsdSendRequest,
      type: "UsdSend" as const,
    }
  } else if (decodedPayload.txType === 1) {
    // Spot Send
    const [request] = decodeAbiParameters(
      SPOT_SEND_REQUEST_ABI,
      decodedPayload.parameters
    )
    return {
      request: request as SpotSendRequest,
      type: "SpotSend" as const,
    }
  } else {
    throw new Error(`Unknown transaction type: ${decodedPayload.txType}`)
  }
}

/**
 * Get the EIP712 types for a Hyperliquid transaction
 * @param txType The transaction type
 * @returns EIP712 types object
 */
export function getHyperliquidEIP712Types(txType: "UsdSend" | "SpotSend") {
  if (txType === "UsdSend") {
    return {
      "HyperliquidTransaction:UsdSend": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "amount", type: "string" },
        { name: "time", type: "uint64" },
      ],
    }
  } else {
    return {
      "HyperliquidTransaction:SpotSend": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "token", type: "string" },
        { name: "amount", type: "string" },
        { name: "time", type: "uint64" },
      ],
    }
  }
}

/**
 * Get the primary type for EIP712 signing
 * @param txType The transaction type
 * @returns Primary type string
 */
export function getHyperliquidPrimaryType(
  txType: "UsdSend" | "SpotSend"
): string {
  return txType === "UsdSend"
    ? "HyperliquidTransaction:UsdSend"
    : "HyperliquidTransaction:SpotSend"
}

/**
 * Create transaction parameters for Hyperliquid client
 * @param request The decoded request
 * @param txType The transaction type
 * @returns Parameters for Hyperliquid client
 */
export function createHyperliquidTxParams(
  request: UsdSendRequest | SpotSendRequest,
  txType: "UsdSend" | "SpotSend"
) {
  if (txType === "UsdSend") {
    const usdRequest = request as UsdSendRequest
    return {
      amount: usdRequest.amount,
      destination: usdRequest.destination as `0x${string}`,
    }
  } else {
    const spotRequest = request as SpotSendRequest
    return {
      amount: spotRequest.amount,
      destination: spotRequest.destination as `0x${string}`,
      token: spotRequest.token,
    }
  }
}

/**
 * Build transaction payload for Hyperliquid API
 * @param request The transaction request
 * @param txType The transaction type
 * @param signature The signature object
 * @param signatureChainId The chain ID used for signing in hex format
 * @returns Transaction payload for API
 */
export function buildHyperliquidApiPayload(
  request: UsdSendRequest | SpotSendRequest,
  txType: "UsdSend" | "SpotSend",
  signature: { r: string; s: string; v: number },
  signatureChainId: string
) {
  const nonce = Number(request.time)

  if (txType === "UsdSend") {
    const usdRequest = request as UsdSendRequest
    return {
      action: {
        amount: usdRequest.amount,
        destination: usdRequest.destination,
        hyperliquidChain: usdRequest.hyperliquidChain,
        signatureChainId,
        time: nonce,
        type: "usdSend",
      },
      nonce,
      signature,
    }
  } else {
    const spotRequest = request as SpotSendRequest
    return {
      action: {
        amount: spotRequest.amount,
        destination: spotRequest.destination,
        hyperliquidChain: spotRequest.hyperliquidChain,
        signatureChainId,
        time: nonce,
        token: spotRequest.token,
        type: "spotSend",
      },
      nonce,
      signature,
    }
  }
}

/**
 * Broadcast transaction to Hyperliquid
 * @param payload The transaction payload
 * @param chain The Hyperliquid chain ('Mainnet' or 'Testnet')
 * @returns Transaction result
 */
export async function broadcastHyperliquidTransaction(
  payload: any,
  apiUrl: string
): Promise<any> {
  console.log("\n📡 Broadcasting Hyperliquid transaction...")
  console.log(`API URL: ${apiUrl}/exchange`)
  console.log("Payload:", JSON.stringify(payload, null, 2))

  // Use dynamic import for fetch to handle Node.js compatibility
  const fetch = (await import("node-fetch")).default

  const response = await fetch(`${apiUrl}/exchange`, {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(
      `Failed to broadcast Hyperliquid transaction: ${response.status} ${error}`
    )
  }

  const result = await response.json()
  console.log("\n🎉 Hyperliquid transaction broadcast successfully!")
  console.log("Result:", result)

  return result
}

/**
 * Query user transaction details from Hyperliquid explorer
 * @param userAddress The user address to query
 * @param chain The Hyperliquid chain ('Mainnet' or 'Testnet')
 * @returns User transaction details
 */
export async function queryHyperliquidUserTxs(
  userAddress: string,
  explorerUrl: string
): Promise<any> {
  console.log(`\n🔍 Querying user transactions for ${userAddress}...`)

  // Use dynamic import for fetch to handle Node.js compatibility
  const fetch = (await import("node-fetch")).default

  const response = await fetch(explorerUrl, {
    body: JSON.stringify({
      type: "userDetails",
      user: userAddress.toLowerCase(),
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(
      `Failed to query user transactions: ${response.status} ${error}`
    )
  }

  const result = await response.json()
  console.log(`📝 Found ${result.txs?.length || 0} transactions for user`)

  return result
}

/**
 * Get the latest transaction hash for a user after broadcasting
 * @param userAddress The user address to check
 * @param chain The Hyperliquid chain ('Mainnet' or 'Testnet')
 * @param beforeTime Optional timestamp to filter transactions after this time
 * @returns The latest transaction hash or null if not found
 */
export async function getLatestUserTxHash(
  userAddress: string,
  explorerUrl: string,
  beforeTime?: number
): Promise<string | null> {
  try {
    const userDetails = await queryHyperliquidUserTxs(userAddress, explorerUrl)

    if (!userDetails.txs || userDetails.txs.length === 0) {
      console.log("⚠️ No transactions found for user")
      return null
    }

    // Sort transactions by time (most recent first)
    const sortedTxs = userDetails.txs.sort((a: any, b: any) => b.time - a.time)

    // If beforeTime is specified, find the first transaction after that time
    let latestTx = sortedTxs[0]
    if (beforeTime) {
      latestTx = sortedTxs.find((tx: any) => tx.time > beforeTime)
    }

    if (latestTx) {
      console.log("✅ Latest transaction found:")
      console.log(`   Hash: ${latestTx.hash}`)
      console.log(`   Time: ${new Date(latestTx.time)}`)
      console.log(`   Block: ${latestTx.block}`)
      console.log(`   Action: ${latestTx.action.type}`)
      console.log(`   Error: ${latestTx.error || "None"}`)

      return latestTx.hash
    } else {
      console.log("⚠️ No recent transactions found")
      return null
    }
  } catch (error) {
    console.error("❌ Error querying user transactions:", error)
    return null
  }
}
