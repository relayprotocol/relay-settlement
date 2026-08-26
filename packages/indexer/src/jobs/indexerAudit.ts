import type { Contract, Provider } from "ethers"
import { config } from "../config.js"
import type { Database } from "../db/connection.js"
import { getMeta } from "../db/meta.js"
import { HUB_TRANSFER_META_KEY } from "../indexerState.js"
import { logger } from "../logger.js"
import { runTransferCoverageAudit } from "../services/indexerAudit.js"

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
