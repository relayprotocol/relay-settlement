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

/** Response from status polling */
export interface WithdrawalStatusResult {
  status: WithdrawalJobStatus
  transaction?: EvmTransactionData
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
  transaction?: EvmTransactionData
  txHash?: string
  error?: string
  failReason?: WithdrawalFailReason
}

export const FAIL_REASON_MESSAGES: Record<WithdrawalFailReason, string> = {
  insufficient_balance: "Insufficient hub balance",
  invalid_signature: "Signature verification failed",
  unsupported_chain: "Chain not supported for withdrawals",
  invalid_amount: "Invalid withdrawal amount",
  chain_disabled: "Chain temporarily disabled",
  internal_error: "Something went wrong, please try again",
}
