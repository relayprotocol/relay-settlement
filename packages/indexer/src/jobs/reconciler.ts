import type { Database } from "../db/connection.js"
import { logger } from "../logger.js"
import { runWithRetry } from "../services/retry.js"

export const startReconciler = (db: Database) => {
  let running = false

  const reconcile = async () => {
    if (running) {
      logger.warn("reconciler", "Skipping overlapping reconcile run")
      return
    }

    running = true
    logger.info("reconciler", "Reconciler job started")

    try {
      const tokens = await db.manyOrNone<{ token_id: string }>(
        "SELECT token_id FROM tokens"
      )

      if (!tokens.length) {
        logger.info("reconciler", "No tokens to reconcile")
        return
      }

      const now = new Date().toISOString()

      for (const token of tokens) {
        await runWithRetry(async () => {
          const balances = await db.manyOrNone<{ balance: string }>(
            "SELECT balance FROM balances WHERE token_id = $1 AND balance > 0",
            [token.token_id]
          )

          let total = 0n
          for (const row of balances) {
            total += BigInt(row.balance)
          }

          await db.none(
            "UPDATE tokens SET total_supply = $1, holders = $2, updated_at = $3 WHERE token_id = $4",
            [total.toString(), balances.length, now, token.token_id]
          )
        })
      }

      logger.info("reconciler", "Reconciler job completed", {
        tokens: tokens.length,
      })
    } catch (error) {
      logger.error("reconciler", "Reconciler failed", { error })
    } finally {
      running = false
    }
  }

  void reconcile()
  logger.info("reconciler", "Reconciler scheduled", {
    intervalMs: 30 * 60 * 1000,
  })
  setInterval(reconcile, 30 * 60 * 1000)
}
