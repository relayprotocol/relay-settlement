import { randomUUID } from "node:crypto"
import { RelayHub } from "@relay-protocol/settlement-abis"
import { Contract, type Provider } from "ethers"
import type { Database } from "../db/connection.js"
import {
  buildTransferReplayProgress,
  buildTransferReplayRequest,
  runTransferReplay,
  type TransferReplayProgress,
  type TransferReplayRequest,
} from "./transferReplay.js"
import { logger } from "../logger.js"

type TransferReplayJobState = "failed" | "running" | "succeeded"

export type TransferReplayJob = {
  completedAt: string | null
  error: string | null
  id: string
  progress: TransferReplayProgress | null
  request: TransferReplayRequest
  startedAt: string
  state: TransferReplayJobState
}

type TransferReplayJobManagerOptions = {
  db: Database
  defaultBatchSize: number
  defaultReconcileChunkSize: number
  hubContractAddress: string
  maxBlockRange: number
  maxRetainedJobs?: number
  provider: Provider
  terminalJobTtlMs?: number
}

export class TransferReplayJobConflictError extends Error {}

const DEFAULT_MAX_RETAINED_JOBS = 25
const DEFAULT_TERMINAL_JOB_TTL_MS = 60 * 60 * 1000

export const createTransferReplayJobManager = (
  options: TransferReplayJobManagerOptions
) => {
  const jobs = new Map<string, TransferReplayJob>()
  const maxRetainedJobs = options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS
  const terminalJobTtlMs =
    options.terminalJobTtlMs ?? DEFAULT_TERMINAL_JOB_TTL_MS
  const hubContract = new Contract(
    options.hubContractAddress,
    RelayHub,
    options.provider
  )

  const snapshotJob = (job: TransferReplayJob) => ({ ...job })

  const pruneTerminalJobs = () => {
    const now = Date.now()
    const terminalJobs = [...jobs.values()]
      .filter((job) => job.state !== "running" && job.completedAt != null)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))

    for (const job of terminalJobs) {
      if (Date.parse(job.completedAt ?? "") + terminalJobTtlMs < now) {
        jobs.delete(job.id)
      }
    }

    const retainedTerminalJobs = [...jobs.values()]
      .filter((job) => job.state !== "running")
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))

    while (retainedTerminalJobs.length > maxRetainedJobs) {
      const job = retainedTerminalJobs.shift()
      if (job) {
        jobs.delete(job.id)
      }
    }
  }

  const start = (input: Record<string, unknown>) => {
    pruneTerminalJobs()

    const runningJob = [...jobs.values()].find((job) => job.state === "running")
    if (runningJob) {
      throw new TransferReplayJobConflictError(
        `Transfer replay job ${runningJob.id} is already running`
      )
    }

    const request = buildTransferReplayRequest(
      input,
      {
        batchSize: options.defaultBatchSize,
        reconcileChunkSize: options.defaultReconcileChunkSize,
      },
      {
        maxBlockRange: options.maxBlockRange,
      }
    )

    const startedAtMs = Date.now()
    const job: TransferReplayJob = {
      completedAt: null,
      error: null,
      id: `transfer-replay-${startedAtMs}-${randomUUID().slice(0, 8)}`,
      progress: buildTransferReplayProgress(
        request,
        {
          decoded: 0,
          inserted: 0,
          reconciledAddresses: 0,
          skipped: 0,
        },
        startedAtMs,
        {
          currentBlock: null,
          lastBatchFromBlock: null,
          lastBatchToBlock: null,
        }
      ),
      request,
      startedAt: new Date(startedAtMs).toISOString(),
      state: "running",
    }
    jobs.set(job.id, job)

    void runTransferReplay(options.db, options.provider, hubContract, request, {
      onProgress: (progress) => {
        job.progress = progress
      },
    })
      .then((result) => {
        job.completedAt = new Date().toISOString()
        job.progress = result
        job.state = "succeeded"
        pruneTerminalJobs()
        logger.info("admin", "Transfer replay job succeeded", {
          jobId: job.id,
          ...result,
        })
      })
      .catch((error: unknown) => {
        job.completedAt = new Date().toISOString()
        job.error = error instanceof Error ? error.message : String(error)
        job.state = "failed"
        pruneTerminalJobs()
        logger.error("admin", "Transfer replay job failed", {
          error,
          jobId: job.id,
        })
      })

    return snapshotJob(job)
  }

  const get = (id: string) => {
    pruneTerminalJobs()

    const job = jobs.get(id)
    return job ? snapshotJob(job) : null
  }

  return { get, start }
}
