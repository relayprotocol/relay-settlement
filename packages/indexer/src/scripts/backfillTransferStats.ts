import "dotenv/config"
import { setTimeout } from "node:timers/promises"
import { closeDb, openDb } from "../db/connection.js"
import { jsonLogger } from "../logger.js"
import {
  backfillTransferStatsBatch,
  resetTransferStatsBackfill,
  withTransferStatsBackfillLock,
} from "../services/transferStatsBackfill.js"

const main = async () => {
  const reset = process.argv.includes("--reset")
  if (!reset && process.env.TRANSFER_STATS_WRITERS_READY !== "1") {
    throw new Error(
      "Verify every API, worker and replay writer maintains minute counts, then set TRANSFER_STATS_WRITERS_READY=1"
    )
  }
  const db = await openDb()
  try {
    await withTransferStatsBackfillLock(db, async (task) => {
      if (reset) {
        await resetTransferStatsBackfill(task)
        jsonLogger.info(
          "transfer-stats-backfill",
          "Summary reads disabled; backfill reset"
        )
        return
      }
      while (true) {
        const result = await backfillTransferStatsBatch(task)
        jsonLogger.info(
          "transfer-stats-backfill",
          "Backfill batch completed",
          result
        )
        if (result.complete) return
        await setTimeout(100)
      }
    })
  } finally {
    await closeDb()
  }
}

main().catch((error) => {
  jsonLogger.error(
    "transfer-stats-backfill",
    "Backfill failed; rerun to resume",
    { error }
  )
  process.exitCode = 1
})
