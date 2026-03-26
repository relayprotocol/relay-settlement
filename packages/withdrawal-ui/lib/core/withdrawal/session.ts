import type { WithdrawalParams, EvmTransactionData } from "./types"

const STORAGE_PREFIX = "relay-withdrawal-"

export type JobStatus =
  | "processing"
  | "ready"
  | "executed"
  | "expired"
  | "failed"

export interface StoredJob {
  jobId: string
  params: WithdrawalParams
  createdAt: number
  status: JobStatus
  nonce?: string
  validatedAmount?: string
  txHash?: string
  transaction?: EvmTransactionData
  withdrawal?: Record<string, unknown>
}

export function saveWithdrawalJob(
  jobId: string,
  params: WithdrawalParams,
  extra?: { nonce?: string; validatedAmount?: string }
): void {
  const entry: StoredJob = {
    jobId,
    params,
    createdAt: Date.now(),
    status: "processing",
    nonce: extra?.nonce,
    validatedAmount: extra?.validatedAmount,
  }
  try {
    localStorage.setItem(STORAGE_PREFIX + jobId, JSON.stringify(entry))
  } catch {
    // localStorage full or unavailable
  }
}

export function updateJobStatus(
  jobId: string,
  status: JobStatus,
  extra?: {
    txHash?: string
    transaction?: EvmTransactionData
    withdrawal?: Record<string, unknown>
  }
): void {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + jobId)
    if (!raw) return
    const entry: StoredJob = JSON.parse(raw)
    entry.status = status
    if (extra?.txHash) entry.txHash = extra.txHash
    if (extra?.transaction) entry.transaction = extra.transaction
    if (extra?.withdrawal) entry.withdrawal = extra.withdrawal
    localStorage.setItem(STORAGE_PREFIX + jobId, JSON.stringify(entry))
  } catch {
    // localStorage unavailable
  }
}

export function getJob(jobId: string): StoredJob | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + jobId)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function getAllJobs(): StoredJob[] {
  const jobs: StoredJob[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(STORAGE_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      jobs.push(JSON.parse(raw))
    }
  } catch {
    // localStorage unavailable
  }
  return jobs.sort((a, b) => b.createdAt - a.createdAt)
}

export function getPendingJobs(): StoredJob[] {
  return getAllJobs().filter(
    (j) => j.status === "processing" || j.status === "ready"
  )
}

export function removeJob(jobId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + jobId)
  } catch {
    // localStorage unavailable
  }
}
