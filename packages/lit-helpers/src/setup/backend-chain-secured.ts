/**
 * ChainSecured-mode backend.
 *
 * Writes are wallet-signed EIP-1559 transactions against the AccountConfig
 * diamond on Base. PKP minting and usage-key minting still go through the
 * Chipotle DStack MPC endpoints (`*_with_signature`), which only require an
 * EIP-712 wallet signature rather than an API key, and are followed by a
 * wallet-signed `registerWalletDerivation` / `setUsageApiKey` transaction.
 *
 * Reads bypass the Chipotle HTTP API entirely and run as `eth_call`s against
 * the contract's view functions, so this backend works without any API key.
 */

import { addr, signTyped, Transaction } from "micro-eth-signer"
import {
  createContract,
  type ContractABI,
} from "micro-eth-signer/advanced/abi.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import type {
  ActionInfo,
  GroupInfo,
  PkpInfo,
  SetupBackend,
  UpdateGroupParams,
  UsageKeyInfo,
} from "./backend.js"

const BASE_URL = "https://api.chipotle.litprotocol.com"

/**
 * Hardcoded Chipotle deployment on Base mainnet. Override these constants
 * directly if you need to target a different Chipotle deployment (staging,
 * local anvil, etc.).
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

/** keccak256(toUtf8Bytes(cid)) as a uint256. */
function hashCidToBigInt(cid: string): bigint {
  return bytesToBigInt(keccak(new TextEncoder().encode(cid)))
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

/** `eth_call` returning the decoded raw bytes, or undefined when the contract returns empty data. */
async function ethCall(
  rpcUrl: string,
  contractAddress: string,
  calldata: Uint8Array
): Promise<Uint8Array | undefined> {
  const result = await rpcCall<string>(rpcUrl, "eth_call", [
    { to: contractAddress, data: toHex(calldata) },
    "latest",
  ])
  if (!result || result === "0x") {
    return undefined
  }
  return fromHex(result)
}

// ─── Contract ABI fragments ──────────────────────────────────────────────────

const VIEW_ABI: ContractABI = [
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "pageNumber", type: "uint256" },
      { name: "pageSize", type: "uint256" },
    ],
    name: "listGroups",
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "id", type: "uint256" },
          { name: "name", type: "string" },
          { name: "description", type: "string" },
        ],
      },
    ],
    type: "function",
  },
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "pageNumber", type: "uint256" },
      { name: "pageSize", type: "uint256" },
    ],
    name: "listPkps",
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "id", type: "uint256" },
          { name: "pkpId", type: "address" },
          { name: "name", type: "string" },
          { name: "description", type: "string" },
        ],
      },
    ],
    type: "function",
  },
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "pageNumber", type: "uint256" },
      { name: "pageSize", type: "uint256" },
    ],
    name: "listActions",
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "id", type: "uint256" },
          { name: "name", type: "string" },
          { name: "description", type: "string" },
        ],
      },
    ],
    type: "function",
  },
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "groupId", type: "uint256" },
      { name: "pageNumber", type: "uint256" },
      { name: "pageSize", type: "uint256" },
    ],
    name: "listWalletsInGroup",
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "id", type: "uint256" },
          { name: "pkpId", type: "address" },
          { name: "name", type: "string" },
          { name: "description", type: "string" },
        ],
      },
    ],
    type: "function",
  },
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "pageNumber", type: "uint256" },
      { name: "pageSize", type: "uint256" },
    ],
    name: "listApiKeys",
    outputs: [
      {
        // listApiKeys nests the metadata trio under `metadata`; the other
        // list* functions are flat.
        type: "tuple[]",
        components: [
          {
            name: "metadata",
            type: "tuple",
            components: [
              { name: "id", type: "uint256" },
              { name: "name", type: "string" },
              { name: "description", type: "string" },
            ],
          },
          { name: "apiKeyHash", type: "uint256" },
          { name: "expiration", type: "uint256" },
          { name: "balance", type: "uint256" },
          { name: "executeInGroups", type: "uint256[]" },
          { name: "createGroups", type: "bool" },
          { name: "deleteGroups", type: "bool" },
          { name: "createPKPs", type: "bool" },
          { name: "manageIPFSIdsInGroups", type: "uint256[]" },
          { name: "addPkpToGroups", type: "uint256[]" },
          { name: "removePkpFromGroups", type: "uint256[]" },
        ],
      },
    ],
    type: "function",
  },
]

const WRITE_ABI: ContractABI = [
  {
    inputs: [
      { name: "apiKeyHash", type: "uint256" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
      { name: "cidHashes", type: "uint256[]" },
      { name: "pkpIds", type: "address[]" },
    ],
    name: "addGroup",
    outputs: [{ name: "", type: "uint256" }],
    type: "function",
  },
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "groupId", type: "uint256" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
      { name: "cidHashes", type: "uint256[]" },
      { name: "pkpIds", type: "address[]" },
    ],
    name: "updateGroup",
    outputs: [],
    type: "function",
  },
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
      { name: "actionHash", type: "uint256" },
    ],
    name: "addAction",
    outputs: [],
    type: "function",
  },
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "actionHash", type: "uint256" },
    ],
    name: "removeAction",
    outputs: [],
    type: "function",
  },
  {
    inputs: [
      { name: "apiKeyHash", type: "uint256" },
      { name: "groupId", type: "uint256" },
      { name: "action", type: "uint256" },
    ],
    name: "addActionToGroup",
    outputs: [],
    type: "function",
  },
  {
    inputs: [
      { name: "apiKeyHash", type: "uint256" },
      { name: "groupId", type: "uint256" },
      { name: "action", type: "uint256" },
    ],
    name: "removeActionFromGroup",
    outputs: [],
    type: "function",
  },
  {
    inputs: [
      { name: "apiKeyHash", type: "uint256" },
      { name: "groupId", type: "uint256" },
      { name: "pkpId", type: "address" },
    ],
    name: "addPkpToGroup",
    outputs: [],
    type: "function",
  },
  {
    inputs: [
      { name: "apiKeyHash", type: "uint256" },
      { name: "pkpId", type: "address" },
      { name: "derivationPath", type: "uint256" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
    ],
    name: "registerWalletDerivation",
    outputs: [],
    type: "function",
  },
  {
    inputs: [
      { name: "accountApiKeyHash", type: "uint256" },
      { name: "usageApiKeyHash", type: "uint256" },
      { name: "expiration", type: "uint256" },
      { name: "balance", type: "uint256" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
      { name: "createGroups", type: "bool" },
      { name: "deleteGroups", type: "bool" },
      { name: "createPKPs", type: "bool" },
      { name: "manageIPFSIdsInGroups", type: "uint256[]" },
      { name: "addPkpToGroups", type: "uint256[]" },
      { name: "removePkpFromGroups", type: "uint256[]" },
      { name: "executeInGroups", type: "uint256[]" },
    ],
    name: "setUsageApiKey",
    outputs: [],
    type: "function",
  },
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

interface ViewMethod {
  encodeInput(args: object): Uint8Array
  decodeOutput(data: Uint8Array): unknown[]
}
interface WriteMethod {
  encodeInput(args: object): Uint8Array
}

interface ViewContract {
  listGroups: ViewMethod
  listPkps: ViewMethod
  listActions: ViewMethod
  listWalletsInGroup: ViewMethod
  listApiKeys: ViewMethod
}

interface WriteContract {
  addGroup: WriteMethod
  updateGroup: WriteMethod
  addAction: WriteMethod
  removeAction: WriteMethod
  addActionToGroup: WriteMethod
  removeActionFromGroup: WriteMethod
  addPkpToGroup: WriteMethod
  registerWalletDerivation: WriteMethod
  setUsageApiKey: WriteMethod
  transferChainSecuredAccountOwnership: WriteMethod
}

const viewContract = createContract(VIEW_ABI) as unknown as ViewContract
export const writeContract = createContract(
  WRITE_ABI
) as unknown as WriteContract

/**
 * Read every entry of a contract list view. The contract ignores `pageNumber`
 * and returns up to `pageSize` items in a single call, so we issue one call
 * with a large page size and widen geometrically when the page comes back full.
 */
async function readAll<T>(
  rpcUrl: string,
  contractAddress: string,
  encodeInput: (page: bigint, pageSize: bigint) => Uint8Array,
  decodeOutput: (data: Uint8Array) => T[]
): Promise<T[]> {
  let pageSize = 100n
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await ethCall(
      rpcUrl,
      contractAddress,
      encodeInput(0n, pageSize)
    )
    if (!raw) {
      return []
    }
    const items = decodeOutput(raw)
    if (BigInt(items.length) < pageSize) {
      return items
    }
    pageSize *= 4n
  }
  throw new Error(`readAll exceeded 5 widen attempts at pageSize=${pageSize}`)
}

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

// ─── HTTP endpoints used by ChainSecured flows ───────────────────────────────

interface CreateWalletWithSignatureResponse {
  wallet_address: string
  derivation_path: string
}

async function createWalletWithSignature(
  adminWalletAddress: string,
  chainId: number,
  privateKey: string
): Promise<CreateWalletWithSignatureResponse> {
  const { typed_data, signature } = signChainSecuredTypedData(
    "CreateWallet",
    adminWalletAddress,
    chainId,
    privateKey
  )
  const res = await fetch(`${BASE_URL}/core/v1/create_wallet_with_signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ typed_data, signature }),
  })
  if (!res.ok) {
    throw new Error(
      `create_wallet_with_signature failed (${res.status}): ${await res.text()}`
    )
  }
  return res.json() as Promise<CreateWalletWithSignatureResponse>
}

interface AddUsageApiKeyWithSignatureResponse {
  usage_api_key: string
  wallet_address: string
  derivation_path: string
}

async function addUsageApiKeyWithSignature(
  adminWalletAddress: string,
  chainId: number,
  privateKey: string
): Promise<AddUsageApiKeyWithSignatureResponse> {
  const { typed_data, signature } = signChainSecuredTypedData(
    "AddUsageApiKey",
    adminWalletAddress,
    chainId,
    privateKey
  )
  const res = await fetch(
    `${BASE_URL}/core/v1/add_usage_api_key_with_signature`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typed_data, signature }),
    }
  )
  if (!res.ok) {
    throw new Error(
      `add_usage_api_key_with_signature failed (${res.status}): ${await res.text()}`
    )
  }
  return res.json() as Promise<AddUsageApiKeyWithSignatureResponse>
}

// ─── Backend ─────────────────────────────────────────────────────────────────

/** Configuration required by the ChainSecured backend. */
export interface ChainSecuredBackendOptions {
  /** Admin wallet private key (0x-prefixed). Signs every contract write. */
  privateKey: string
  /**
   * Master account API key. Used solely to derive the on-chain account hash
   * (`keccak256(toUtf8Bytes(accountApiKey))`) so the same key identifies the
   * account in both backends.
   */
  accountApiKey: string
  /** Metadata to register when this backend mints a fresh PKP. */
  pkpName: string
  pkpDescription: string
}

/**
 * Construct a ChainSecured backend. The Chipotle deployment address, chain
 * id, and RPC URL are pinned to the constants near the top of this file;
 * edit them there to target a different deployment.
 */
export function createChainSecuredBackend(
  opts: ChainSecuredBackendOptions
): SetupBackend {
  return new ChainSecuredBackend({
    privateKey: opts.privateKey,
    adminHash: bytesToBigInt(
      keccak(new TextEncoder().encode(opts.accountApiKey))
    ),
    contractAddress: DEFAULT_ACCOUNT_CONFIG_ADDRESS,
    chainId: DEFAULT_BASE_CHAIN_ID,
    rpcUrl: DEFAULT_BASE_RPC_URL,
    pkpName: opts.pkpName,
    pkpDescription: opts.pkpDescription,
  })
}

/** Internal config the class actually uses. */
interface InternalOptions {
  privateKey: string
  adminHash: bigint
  contractAddress: string
  chainId: bigint
  rpcUrl: string
  pkpName: string
  pkpDescription: string
}

class ChainSecuredBackend implements SetupBackend {
  readonly mode = "chain-secured" as const
  private readonly adminWalletAddress: string

  constructor(private readonly opts: InternalOptions) {
    const normalized = opts.privateKey.startsWith("0x")
      ? opts.privateKey
      : `0x${opts.privateKey}`
    this.adminWalletAddress = addr.fromPrivateKey(normalized).toLowerCase()
    // Keep the normalized key in opts so later signers don't have to re-normalize.
    this.opts = { ...opts, privateKey: normalized }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  private async send(calldata: Uint8Array): Promise<string> {
    return sendTransaction(
      this.opts.rpcUrl,
      this.opts.chainId,
      this.opts.privateKey,
      this.opts.contractAddress,
      calldata
    )
  }

  // ── Reads ───────────────────────────────────────────────────────────────
  async listPkps(): Promise<PkpInfo[]> {
    const rows = await readAll(
      this.opts.rpcUrl,
      this.opts.contractAddress,
      (page, size) =>
        viewContract.listPkps.encodeInput({
          accountApiKeyHash: this.opts.adminHash,
          pageNumber: page,
          pageSize: size,
        }),
      (data) =>
        viewContract.listPkps.decodeOutput(data) as Array<{
          id: bigint
          pkpId: string
          name: string
          description: string
        }>
    )
    return rows.map((r) => ({
      walletAddress: r.pkpId,
      name: r.name,
      description: r.description,
    }))
  }

  async listGroups(): Promise<GroupInfo[]> {
    const rows = await readAll(
      this.opts.rpcUrl,
      this.opts.contractAddress,
      (page, size) =>
        viewContract.listGroups.encodeInput({
          accountApiKeyHash: this.opts.adminHash,
          pageNumber: page,
          pageSize: size,
        }),
      (data) =>
        viewContract.listGroups.decodeOutput(data) as Array<{
          id: bigint
          name: string
          description: string
        }>
    )
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
    }))
  }

  async listActions(): Promise<ActionInfo[]> {
    const rows = await readAll(
      this.opts.rpcUrl,
      this.opts.contractAddress,
      (page, size) =>
        viewContract.listActions.encodeInput({
          accountApiKeyHash: this.opts.adminHash,
          pageNumber: page,
          pageSize: size,
        }),
      (data) =>
        viewContract.listActions.decodeOutput(data) as Array<{
          id: bigint
          name: string
          description: string
        }>
    )
    // The contract stores `actionMetadata[actionHash].id = actionHash`, so the
    // `id` IS the actionHash. Tombstones (id === 0n) are excluded.
    return rows
      .filter((r) => r.id !== 0n)
      .map((r) => ({
        actionHash: r.id,
        name: r.name,
        description: r.description,
      }))
  }

  async listUsageApiKeys(): Promise<UsageKeyInfo[]> {
    const rows = await readAll(
      this.opts.rpcUrl,
      this.opts.contractAddress,
      (page, size) =>
        viewContract.listApiKeys.encodeInput({
          accountApiKeyHash: this.opts.adminHash,
          pageNumber: page,
          pageSize: size,
        }),
      (data) =>
        viewContract.listApiKeys.decodeOutput(data) as Array<{
          metadata: { name: string }
        }>
    )
    return rows.map((r) => ({ name: r.metadata.name }))
  }

  async listPkpsInGroup(groupId: bigint): Promise<PkpInfo[]> {
    const rows = await readAll(
      this.opts.rpcUrl,
      this.opts.contractAddress,
      (page, size) =>
        viewContract.listWalletsInGroup.encodeInput({
          accountApiKeyHash: this.opts.adminHash,
          groupId,
          pageNumber: page,
          pageSize: size,
        }),
      (data) =>
        viewContract.listWalletsInGroup.decodeOutput(data) as Array<{
          id: bigint
          pkpId: string
          name: string
          description: string
        }>
    )
    return rows.map((r) => ({
      walletAddress: r.pkpId,
      name: r.name,
      description: r.description,
    }))
  }

  // ── Writes ──────────────────────────────────────────────────────────────
  async createPkp(): Promise<{ walletAddress: string }> {
    const minted = await createWalletWithSignature(
      this.adminWalletAddress,
      Number(this.opts.chainId),
      this.opts.privateKey
    )

    const calldata = writeContract.registerWalletDerivation.encodeInput({
      apiKeyHash: this.opts.adminHash,
      pkpId: minted.wallet_address,
      derivationPath: BigInt(minted.derivation_path),
      name: this.opts.pkpName,
      description: this.opts.pkpDescription,
    })
    await this.send(calldata)
    return { walletAddress: minted.wallet_address }
  }

  async addGroup(name: string, description: string): Promise<bigint> {
    const calldata = writeContract.addGroup.encodeInput({
      apiKeyHash: this.opts.adminHash,
      name,
      description,
      cidHashes: [],
      pkpIds: [],
    })
    await this.send(calldata)

    // Re-read to discover the new id.
    const groups = await this.listGroups()
    const created = groups.find((g) => g.name === name)
    if (!created) {
      throw new Error(`Failed to find group "${name}" after creation`)
    }
    return created.id
  }

  async addPkpToGroup(groupId: bigint, pkpId: string): Promise<void> {
    const calldata = writeContract.addPkpToGroup.encodeInput({
      apiKeyHash: this.opts.adminHash,
      groupId,
      pkpId,
    })
    await this.send(calldata)
  }

  async addAction(
    name: string,
    description: string,
    cid: string
  ): Promise<void> {
    const calldata = writeContract.addAction.encodeInput({
      accountApiKeyHash: this.opts.adminHash,
      name,
      description,
      actionHash: hashCidToBigInt(cid),
    })
    await this.send(calldata)
  }

  async addActionToGroup(groupId: bigint, cid: string): Promise<void> {
    const calldata = writeContract.addActionToGroup.encodeInput({
      apiKeyHash: this.opts.adminHash,
      groupId,
      action: hashCidToBigInt(cid),
    })
    await this.send(calldata)
  }

  async removeActionFromGroup(
    groupId: bigint,
    actionHash: bigint
  ): Promise<void> {
    try {
      const calldata = writeContract.removeActionFromGroup.encodeInput({
        apiKeyHash: this.opts.adminHash,
        groupId,
        action: actionHash,
      })
      await this.send(calldata)
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]
      console.log(`     (skipped removeActionFromGroup: ${msg})`)
    }
  }

  async removeAction(actionHash: bigint): Promise<void> {
    try {
      const calldata = writeContract.removeAction.encodeInput({
        accountApiKeyHash: this.opts.adminHash,
        actionHash,
      })
      await this.send(calldata)
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]
      console.log(`     (skipped removeAction: ${msg})`)
    }
  }

  async updateGroup(groupId: bigint, params: UpdateGroupParams): Promise<void> {
    const calldata = writeContract.updateGroup.encodeInput({
      accountApiKeyHash: this.opts.adminHash,
      groupId,
      name: params.name,
      description: params.description,
      cidHashes: params.cidHashesPermitted,
      pkpIds: params.pkpIdsPermitted,
    })
    await this.send(calldata)
  }

  async createUsageApiKey(
    name: string,
    description: string,
    executeInGroupIds: bigint[]
  ): Promise<string> {
    // Mint the wallet behind the usage key via DStack MPC.
    const minted = await addUsageApiKeyWithSignature(
      this.adminWalletAddress,
      Number(this.opts.chainId),
      this.opts.privateKey
    )

    // Register the new wallet derivation on-chain.
    const regCalldata = writeContract.registerWalletDerivation.encodeInput({
      apiKeyHash: this.opts.adminHash,
      pkpId: minted.wallet_address,
      derivationPath: BigInt(minted.derivation_path),
      name,
      description,
    })
    await this.send(regCalldata)

    // keccak256 over the raw 32-byte secret bytes (base64-decoded).
    const keyBytes = Buffer.from(minted.usage_api_key, "base64")
    const usageApiKeyHash = bytesToBigInt(keccak(new Uint8Array(keyBytes)))

    // Attach the key to the account with execute permission for the given groups.
    const setCalldata = writeContract.setUsageApiKey.encodeInput({
      accountApiKeyHash: this.opts.adminHash,
      usageApiKeyHash,
      expiration: 0n,
      balance: 0n,
      name,
      description,
      createGroups: false,
      deleteGroups: false,
      createPKPs: false,
      manageIPFSIdsInGroups: [],
      addPkpToGroups: [],
      removePkpFromGroups: [],
      executeInGroups: executeInGroupIds,
    })
    await this.send(setCalldata)

    return minted.usage_api_key
  }
}
