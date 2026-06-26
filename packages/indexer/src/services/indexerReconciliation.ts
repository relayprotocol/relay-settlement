import type { Contract } from "ethers"
import type { Database, Queryable } from "../db/connection.js"
import {
  type IndexerAuditFinding,
  type IndexerAuditKind,
} from "./indexerAudit.js"
import { reconcileTransferStateFromChain } from "./transferProcessor.js"

export type IndexerReconciliationJobStatus =
  | "failed"
  | "pending"
  | "running"
  | "succeeded"

export type IndexerReconciliationJob = {
  address: string
  attemptCount: number
  id: number
  kind: IndexerAuditKind
  sourceAuditRunId: number | null
  tokenId: string
}

export type ProcessReconciliationResult = {
  claimed: number
  failed: number
  succeeded: number
}

type ReconciliationJobRow = {
  address: string
  attempt_count: number | string
  id: number | string
  kind: IndexerAuditKind
  source_audit_run_id: number | string | null
  token_id: string
}

const normalizeJob = (row: ReconciliationJobRow): IndexerReconciliationJob => ({
  address: row.address,
  attemptCount: Number(row.attempt_count),
  id: Number(row.id),
  kind: row.kind,
  sourceAuditRunId:
    row.source_audit_run_id == null ? null : Number(row.source_audit_run_id),
  tokenId: row.token_id,
})

const isAutoReconcileableFinding = (
  finding: IndexerAuditFinding
): finding is IndexerAuditFinding & {
  address: string
  tokenId: string
} =>
  finding.kind === "balance-drift" &&
  finding.classification === "confirmed" &&
  Boolean(finding.address) &&
  Boolean(finding.tokenId)

export const enqueueBalanceDriftReconciliations = async (
  db: Queryable,
  auditRunId: number,
  findings: IndexerAuditFinding[]
) => {
  let enqueued = 0
  const now = new Date().toISOString()

  for (const finding of findings) {
    if (!isAutoReconcileableFinding(finding)) {
      continue
    }

    const result = await db.result(
      `INSERT INTO indexer_reconciliation_jobs(
        kind, status, source_audit_run_id, token_id, address,
        source_latest_event_block, source_indexed_balance, source_chain_balance,
        attempt_count, last_error, started_at, completed_at, created_at, updated_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, 0, NULL, NULL, NULL, $9, $9)
      ON CONFLICT(kind, token_id, address) DO UPDATE SET
        status = CASE
          WHEN indexer_reconciliation_jobs.status = 'running'
            THEN indexer_reconciliation_jobs.status
          ELSE EXCLUDED.status
        END,
        source_audit_run_id = EXCLUDED.source_audit_run_id,
        source_latest_event_block = EXCLUDED.source_latest_event_block,
        source_indexed_balance = EXCLUDED.source_indexed_balance,
        source_chain_balance = EXCLUDED.source_chain_balance,
        last_error = CASE
          WHEN indexer_reconciliation_jobs.status = 'running'
            THEN indexer_reconciliation_jobs.last_error
          ELSE NULL
        END,
        completed_at = CASE
          WHEN indexer_reconciliation_jobs.status = 'running'
            THEN indexer_reconciliation_jobs.completed_at
          ELSE NULL
        END,
        updated_at = EXCLUDED.updated_at`,
      [
        "balance-drift",
        "pending",
        auditRunId,
        finding.tokenId,
        finding.address.toLowerCase(),
        finding.latestEventBlock,
        finding.indexedBalance,
        finding.chainBalance,
        now,
      ]
    )
    enqueued += result.rowCount
  }

  return enqueued
}

const claimPendingReconciliationJobs = async (
  db: Database,
  options: {
    limit: number
    staleAfterMs: number
  }
) => {
  const limit = Math.max(1, Math.trunc(options.limit))
  const staleAfterMs = Math.max(1, Math.trunc(options.staleAfterMs))

  const rows = await db.tx((tx) =>
    tx.manyOrNone<ReconciliationJobRow>(
      `WITH candidates AS (
        SELECT id
        FROM indexer_reconciliation_jobs
        WHERE kind = 'balance-drift'
          AND (
            status = 'pending'
            OR (
              status = 'running'
              AND updated_at < NOW() - ($2 * INTERVAL '1 millisecond')
            )
          )
        ORDER BY updated_at ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE indexer_reconciliation_jobs jobs
      SET status = 'running',
          attempt_count = jobs.attempt_count + 1,
          started_at = NOW(),
          updated_at = NOW()
      FROM candidates
      WHERE jobs.id = candidates.id
      RETURNING jobs.id, jobs.kind, jobs.source_audit_run_id,
                jobs.token_id, jobs.address, jobs.attempt_count`,
      [limit, staleAfterMs]
    )
  )

  return rows.map(normalizeJob)
}

const completeReconciliationJob = async (
  db: Queryable,
  jobId: number,
  input: {
    error?: string | null
    status: Extract<IndexerReconciliationJobStatus, "failed" | "succeeded">
  }
) => {
  await db.none(
    `UPDATE indexer_reconciliation_jobs
     SET status = $1,
         last_error = $2,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $3`,
    [input.status, input.error ?? null, jobId]
  )
}

export const processPendingBalanceDriftReconciliations = async (
  db: Database,
  contract: Contract,
  options: {
    limit: number
    staleAfterMs: number
  }
): Promise<ProcessReconciliationResult> => {
  const jobs = await claimPendingReconciliationJobs(db, options)
  let failed = 0
  let succeeded = 0

  for (const job of jobs) {
    try {
      await reconcileTransferStateFromChain(db, contract, job.tokenId, [
        job.address,
      ])
      await completeReconciliationJob(db, job.id, {
        status: "succeeded",
      })
      succeeded += 1
    } catch (error) {
      failed += 1
      await completeReconciliationJob(db, job.id, {
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      })
    }
  }

  return {
    claimed: jobs.length,
    failed,
    succeeded,
  }
}
