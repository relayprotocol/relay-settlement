/** UI-side step (local state machine) */
export type WithdrawalStep =
  | "idle"
  | "preparing"
  | "signing"
  | "executing"
  | "polling"
  | "submitting"
  | "done"

/** API-returned statuses (from GET /withdrawals/status) */
export type WithdrawalJobStatus =
  | "processing"
  | "initiating"
  | "attesting"
  | "ready"
  | "executed"
  | "expired"
  | "failed"

export type WithdrawalFailReason =
  | "insufficient_balance"
  | "invalid_signature"
  | "unsupported_chain"
  | "invalid_amount"
  | "chain_disabled"
  | "internal_error"

/** Props passed into the withdrawal UI (caller provides these) */
export interface WithdrawalConfig {
  chainId: string // numeric chain ID (for wallet chain switch)
  chainSlug: string // chain slug = protocol chain ID (for API calls + hub address, e.g. "ethereum")
  currency: string
  decimals: number // token decimals (for amount conversion)
  ownerAddress: string // wallet address matching the chain's VM type
  ownerChainId: string // numeric (for wallet)
  ownerChainSlug: string // slug = protocol chain ID (for API + hub address)
  vmType: string // solver vmType shortcode (e.g. "evm")
}

export interface WithdrawalParams extends WithdrawalConfig {
  amount: string
  owner: string
  recipient: string
}

/** Response from prepare phase */
export interface PrepareResult {
  nonce: string
  amount: string
  additionalData?: Record<string, unknown>
}

/** Response from execute phase */
export interface ExecuteResult {
  jobId: string
  status: string
}

/** EVM transaction data returned by API when status = "ready" */
export interface EvmTransactionData {
  from: string
  to: string
  data: string
  value: string
  chainId: number
  gas: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}

/** Solana transaction data — instructions to build a VersionedTransaction */
export interface SolanaTransactionData {
  instructions: Array<{
    keys: Array<{
      pubkey: string
      isSigner: boolean
      isWritable: boolean
    }>
    programId: string
    data: string // hex-encoded instruction data
  }>
  addressLookupTableAddresses?: string[]
}

/** Bitcoin transaction data — PSBT with allocator signature, finalized in submit.ts */
export interface BitcoinTransactionData {
  psbt: string // hex-encoded PSBT from solver (allocator already signed)
}

/** Tron transaction data — smart contract trigger or native transfer */
export interface TronTransactionData {
  type: "TriggerSmartContract" | "TransferContract"
  parameter: {
    owner_address: string
    contract_address?: string
    data?: string
    call_value?: number
    to_address?: string
    amount?: number
  }
}

/** Sui transaction data — serialized transaction block */
export interface SuiTransactionData {
  data: string // hex-encoded transaction block bytes
}

/** Hyperliquid transaction data — pre-signed exchange action */
export interface HyperliquidTransactionData {
  action: {
    type: string
    parameters: Record<string, unknown>
  }
  nonce: number
  eip712Types: Record<string, Array<{ name: string; type: string }>>
  eip712PrimaryType: string
  signer: string
  signature: string // raw hex from allocator, parsed to {r,s,v} in submit.ts
  signatureChainId?: string
}

/** VM-specific transaction data — opaque to state machine, dispatched per VM in submit.ts */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VmTransactionData = any

/** Response from status polling */
export interface WithdrawalStatusResult {
  status: WithdrawalJobStatus
  transaction?: VmTransactionData
  withdrawal?: Record<string, unknown>
  reason?: WithdrawalFailReason
}

export interface WithdrawalState {
  step: WithdrawalStep
  jobStatus?: WithdrawalJobStatus
  jobId?: string
  nonce?: string
  validatedAmount?: string
  additionalData?: Record<string, unknown>
  transaction?: VmTransactionData
  txHash?: string
  error?: string
  failReason?: WithdrawalFailReason
  /** Populated in testMode — signing result for manual review without submitting */
  testModeResult?: { digest: string; signature: string }
}

export const FAIL_REASON_MESSAGES: Record<WithdrawalFailReason, string> = {
  insufficient_balance: "Insufficient hub balance",
  invalid_signature: "Signature verification failed",
  unsupported_chain: "Chain not supported for withdrawals",
  invalid_amount: "Invalid withdrawal amount",
  chain_disabled: "Chain temporarily disabled",
  internal_error: "Something went wrong, please try again",
}
