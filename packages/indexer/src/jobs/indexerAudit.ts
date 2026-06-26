import type { Contract, Provider } from "ethers"
import { config } from "../config.js"
import type { Database } from "../db/connection.js"
import { getMeta } from "../db/meta.js"
import { HUB_TRANSFER_META_KEY } from "../indexerState.js"
import { logger } from "../logger.js"
import {
  runBalanceDriftAudit,
  runTransferCoverageAudit,
} from "../services/indexerAudit.js"
import {
  enqueueBalanceDriftReconciliations,
  processPendingBalanceDriftReconciliations,
} from "../services/indexerReconciliation.js"

export const startIndexerAudit = (
  db: Database,
  provider: Provider,
  hubContract: Contract
) => {
  let running = false

  const audit = async () => {
    if (running) {
      logger.warn("audit", "Skipping overlapping indexer audit run")
      return
    }

    running = true
    logger.info("audit", "Indexer audit started")

    try {
      const checkpoint = await getMeta(db, HUB_TRANSFER_META_KEY)
      if (!checkpoint) {
        logger.warn("audit", "Skipping indexer audit until checkpoint exists")
        return
      }

      if (config.balanceDriftAuditEnabled) {
        try {
          const balanceResult = await runBalanceDriftAudit(
            db,
            provider,
            hubContract,
            {
              batchSize: config.balanceDriftAuditBatchSize,
              graceBlocks: config.balanceDriftAuditGraceBlocks,
              maxReplayRange: config.maxTransferReplayBlockRange,
              replayPaddingBlocks: config.transferOverlapBlocks,
            }
          )
          logger.info("audit", "Balance drift audit completed", {
            checked: balanceResult.checkedCount,
            confirmed: balanceResult.confirmedCount,
            pending: balanceResult.pendingCount,
            runId: balanceResult.runId,
          })

          if (config.indexerDriftAutoReconcileEnabled) {
            const enqueued = await enqueueBalanceDriftReconciliations(
              db,
              balanceResult.runId,
              balanceResult.findings
            )
            const reconciled = await processPendingBalanceDriftReconciliations(
              db,
              hubContract,
              {
                limit: config.indexerDriftAutoReconcileBatchSize,
                staleAfterMs: config.indexerDriftAutoReconcileStaleMs,
              }
            )
            logger.info("audit", "Balance drift auto-reconcile completed", {
              claimed: reconciled.claimed,
              enqueued,
              failed: reconciled.failed,
              succeeded: reconciled.succeeded,
            })
          }
        } catch (error) {
          logger.error("audit", "Balance drift audit failed", { error })
        }
      }

      try {
        const coverageResult = await runTransferCoverageAudit(
          db,
          provider,
          hubContract,
          {
            lookbackBlocks: config.transferCoverageAuditLookbackBlocks,
            maxReplayRange: config.maxTransferReplayBlockRange,
            replayPaddingBlocks: config.transferOverlapBlocks,
          }
        )
        logger.info("audit", "Transfer coverage audit completed", {
          checked: coverageResult.checkedCount,
          confirmed: coverageResult.confirmedCount,
          pending: coverageResult.pendingCount,
          runId: coverageResult.runId,
        })
      } catch (error) {
        logger.error("audit", "Transfer coverage audit failed", { error })
      }
    } catch (error) {
      logger.error("audit", "Indexer audit failed", { error })
    } finally {
      running = false
    }
  }

  void audit()
  const intervalMs = Math.max(60 * 1000, config.indexerAuditIntervalMs)
  logger.info("audit", "Indexer audit scheduled", {
    intervalMs,
  })
  setInterval(audit, intervalMs)
}
