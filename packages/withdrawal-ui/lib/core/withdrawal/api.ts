import { SOLVER_API_URL } from "@/lib/config"
import type {
  PrepareResult,
  ExecuteResult,
  WithdrawalStatusResult,
} from "./types"

/** Map backend error messages to user-friendly text */
function friendlyApiError(message: string, fallback: string): string {
  if (!message) return fallback

  if (/insufficient balance/i.test(message))
    return "Insufficient hub balance for this amount"
  if (/solver cannot use/i.test(message))
    return "This address cannot perform withdrawals"
  if (/nonce is required/i.test(message))
    return "Session expired, please try again"
  if (/missing.*depository/i.test(message))
    return "This chain is not supported for withdrawals"
  if (/unable to map.*chain/i.test(message))
    return "This chain is not configured for withdrawals"
  if (/must match pattern/i.test(message)) return "Invalid request format"

  // Return original if no match, but cap length
  return message.length > 120 ? message.slice(0, 120) + "..." : message
}

interface PrepareParams {
  chainId: string
  currency: string
  amount: string
  ownerChainId: string
  owner: string
  recipient: string
}

/** Step 1: Prepare withdrawal — get nonce and validated amount */
export async function prepareWithdrawal(
  params: PrepareParams
): Promise<PrepareResult> {
  const res = await fetch(`${SOLVER_API_URL}/withdrawals/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      friendlyApiError(body.message, `Prepare failed (${res.status})`)
    )
  }
  return res.json()
}

interface ExecuteParams extends PrepareParams {
  nonce: string
  additionalData?: Record<string, unknown>
  signature: string
}

/** Step 3: Execute withdrawal — submit signature, get jobId */
export async function executeWithdrawal(
  params: ExecuteParams
): Promise<ExecuteResult> {
  const res = await fetch(`${SOLVER_API_URL}/withdrawals/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      friendlyApiError(body.message, `Execute failed (${res.status})`)
    )
  }
  return res.json()
}

interface AttestDepositParams {
  chainId: number
  transactionId: string
}

/** Attest a deposit transaction so its balance is reflected on the hub */
export async function attestDeposit(
  params: AttestDepositParams
): Promise<void> {
  const res = await fetch(`${SOLVER_API_URL}/withdrawals/attest-deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      friendlyApiError(body.message, `Attest deposit failed (${res.status})`)
    )
  }
}

/** Step 4: Poll withdrawal status */
export async function getWithdrawalStatus(
  jobId: string
): Promise<WithdrawalStatusResult> {
  const res = await fetch(
    `${SOLVER_API_URL}/withdrawals/status?id=${encodeURIComponent(jobId)}`
  )
  if (res.status === 429) {
    throw new Error("rate_limited")
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? `Status check failed (${res.status})`)
  }
  return res.json()
}
