import { addr, signTyped, Transaction } from "micro-eth-signer"
import {
  createContract,
  type ContractABI,
} from "micro-eth-signer/advanced/abi.js"
import { keccak_256 } from "@noble/hashes/sha3.js"

/**
 * Hardcoded Chipotle ChainSecured deployment on Base mainnet. Override these
 * constants directly if you need to target a different Chipotle deployment
 * (staging, local anvil, etc.).
 */
export const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org"
export const DEFAULT_BASE_CHAIN_ID = 8453n
export const DEFAULT_ACCOUNT_CONFIG_ADDRESS =
  "0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa"

// ─── Hex / hash primitives ───────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "")
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n
  for (const b of bytes) {
    n = (n << 8n) + BigInt(b)
  }
  return n
}

export function keccak(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(keccak_256(bytes))
}

// ─── RPC ─────────────────────────────────────────────────────────────────────

const RPC_THROTTLE_MS = 150
const RPC_MAX_RETRIES = 6
const RPC_INITIAL_BACKOFF_MS = 1_000

let rpcLastCallAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type JsonRpcSuccess<T> = { jsonrpc: string; id: number; result: T }
type JsonRpcFailure = {
  jsonrpc: string
  id: number
  error: { code?: number; message: string }
}

/** JSON-RPC with throttling + retry-on-429 to survive rate-limited public RPCs. */
async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const sinceLast = Date.now() - rpcLastCallAt
  if (sinceLast < RPC_THROTTLE_MS) {
    await sleep(RPC_THROTTLE_MS - sinceLast)
  }

  let backoff = RPC_INITIAL_BACKOFF_MS
  for (let attempt = 1; attempt <= RPC_MAX_RETRIES; attempt++) {
    rpcLastCallAt = Date.now()
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt === RPC_MAX_RETRIES) {
        throw new Error(
          `RPC HTTP ${res.status} for ${method} after ${attempt} attempts`
        )
      }
      const retryAfter = res.headers.get("retry-after")
      const waitMs = Math.max(
        retryAfter ? Number.parseFloat(retryAfter) * 1000 : 0,
        backoff
      )
      console.error(
        `   (RPC ${res.status} — retrying after ${waitMs}ms, attempt ${attempt}/${RPC_MAX_RETRIES})`
      )
      await sleep(waitMs)
      backoff *= 2
      continue
    }

    if (!res.ok) {
      throw new Error(
        `RPC HTTP ${res.status} for ${method}: ${await res.text()}`
      )
    }
    const body = (await res.json()) as JsonRpcSuccess<T> | JsonRpcFailure
    if ("error" in body) {
      throw new Error(`RPC error for ${method}: ${body.error.message}`)
    }
    return body.result
  }
  throw new Error(`RPC unreachable for ${method}`)
}

// ─── Contract ABI fragments ──────────────────────────────────────────────────

const WRITE_ABI: ContractABI = [
  {
    inputs: [
      { name: "apiKeyHash", type: "uint256" },
      { name: "newAdminWalletAddress", type: "address" },
    ],
    name: "transferChainSecuredAccountOwnership",
    outputs: [],
    type: "function",
  },
]

interface WriteMethod {
  encodeInput(args: object): Uint8Array
}

interface WriteContract {
  transferChainSecuredAccountOwnership: WriteMethod
}

export const writeContract = createContract(
  WRITE_ABI
) as unknown as WriteContract

// ─── EIP-712 Lit ChainSecured signing ────────────────────────────────────────

export type ChainSecuredPrimaryType =
  | "CreateWallet"
  | "AddUsageApiKey"
  | "ConvertAccount"

/**
 * Build + sign the canonical Lit ChainSecured EIP-712 payload for the
 * `*_with_signature` HTTP endpoints. The `primaryType` pins the signature to
 * a specific flow so signatures can't be replayed across endpoints.
 */
export function signChainSecuredTypedData(
  primaryType: ChainSecuredPrimaryType,
  adminWalletAddress: string,
  chainId: number,
  privateKey: string
): { typed_data: object; signature: string } {
  const issuedAt = Math.floor(Date.now() / 1000)
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      [primaryType]: [
        { name: "address", type: "address" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType,
    domain: {
      name: "Lit ChainSecured",
      version: "1",
      chainId: String(chainId),
    },
    message: {
      address: adminWalletAddress,
      issuedAt: String(issuedAt),
    },
  }
  const signature = signTyped(
    typedData as unknown as Parameters<typeof signTyped>[0],
    privateKey
  )
  return { typed_data: typedData, signature }
}

// ─── Transaction sending ─────────────────────────────────────────────────────

/**
 * Build, sign, and broadcast an EIP-1559 transaction; wait for the receipt.
 * Prints the equivalent `cast call` line first so reverts can be reproduced
 * offline.
 */
export async function sendTransaction(
  rpcUrl: string,
  chainId: bigint,
  privateKey: string,
  to: string,
  calldata: Uint8Array
): Promise<string> {
  const fromAddress = addr.fromPrivateKey(privateKey)
  const calldataHex = toHex(calldata)
  console.log(
    `     cast call --rpc-url ${rpcUrl} ${to} '${calldataHex}' --from ${fromAddress}`
  )

  const [nonceHex, feeData] = await Promise.all([
    rpcCall<string>(rpcUrl, "eth_getTransactionCount", [
      fromAddress,
      "pending",
    ]),
    rpcCall<{ baseFeePerGas: string[] }>(rpcUrl, "eth_feeHistory", [
      1,
      "latest",
      [50],
    ]).then((h) => {
      const baseFee = BigInt(h.baseFeePerGas?.[0] ?? "0x1")
      return {
        maxFeePerGas: baseFee * 2n + 1_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
      }
    }),
  ])

  const gasEstimate = await rpcCall<string>(rpcUrl, "eth_estimateGas", [
    { from: fromAddress, to, data: calldataHex },
  ])
  const gasLimit = (BigInt(gasEstimate) * 12n) / 10n

  const tx = Transaction.prepare({
    to,
    nonce: BigInt(nonceHex),
    value: 0n,
    data: calldataHex,
    chainId,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    gasLimit,
  })
  const signed = tx.signBy(privateKey)
  const txHash = await rpcCall<string>(rpcUrl, "eth_sendRawTransaction", [
    signed.toHex(true),
  ])

  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const receipt = await rpcCall<{ status: string } | null>(
      rpcUrl,
      "eth_getTransactionReceipt",
      [txHash]
    )
    if (receipt) {
      if (receipt.status !== "0x1") {
        throw new Error(`Transaction reverted: ${txHash}`)
      }
      return txHash
    }
  }
  throw new Error(`Transaction not mined after 2 minutes: ${txHash}`)
}
