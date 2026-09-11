import type { Contract } from "ethers"
import type { Database } from "../db/connection.js"
import { config } from "../config.js"
import { jsonLogger } from "../logger.js"
import { runDepositoryBalanceAudit } from "../services/depositoryBalanceAudit.js"

const DEPOSITORY_BALANCE_AUDIT_ADVISORY_LOCK_NAME =
  "settlement-indexer:depository-balance-audit"
const LOG_SCOPE = "depository-balance-audit"

export const startDepositoryBalanceAudit = (
  db: Database,
  hubContract: Contract
) => {
  let running = false

  const audit = async () => {
    if (running) {
      jsonLogger.warn(LOG_SCOPE, "Skipping overlapping audit run", {
        event: "audit_skipped",
        reason: "overlapping_run",
      })
      return
    }

    running = true
    try {
      await db.task(async (task) => {
        const lock = await task.one<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
          [DEPOSITORY_BALANCE_AUDIT_ADVISORY_LOCK_NAME]
        )
        if (!lock.acquired) {
          jsonLogger.info(
            LOG_SCOPE,
            "Skipping audit because another worker holds the lock",
            {
              event: "audit_skipped",
              reason: "advisory_lock_held",
            }
          )
          return
        }

        try {
          jsonLogger.info(LOG_SCOPE, "Audit started", {
            event: "audit_started",
          })
          const result = await runDepositoryBalanceAudit(task, hubContract, {
            oracleApiKey: config.oracleApiKey,
            oracleApiUrl: config.oracleApiUrl,
          })

          for (const finding of result.results) {
            const findingData = {
              auditStatus: finding.status,
              chainId: finding.chainId,
              currency: finding.currency,
              decimals: finding.decimals,
              delta: finding.deltaFormatted,
              deltaBaseUnits: finding.delta,
              depository: finding.depository,
              depositoryBalance: finding.depositoryBalanceFormatted,
              depositoryBalanceBaseUnits: finding.depositoryBalance,
              error: finding.error,
              event: "currency_check",
              tokenId: finding.tokenId,
              tokenName: finding.tokenName,
              tokenSymbol: finding.tokenSymbol,
              totalSupply: finding.totalSupplyFormatted,
              totalSupplyBaseUnits: finding.totalSupply,
              vmType: finding.vmType,
            }

            if (finding.status === "deficit") {
              jsonLogger.error(
                LOG_SCOPE,
                "Depository balance is below Hub total supply",
                findingData
              )
            } else if (finding.status === "covered") {
              jsonLogger.info(
                LOG_SCOPE,
                "Depository balance covers Hub total supply",
                findingData
              )
            } else if (finding.status === "error") {
              jsonLogger.error(LOG_SCOPE, "Currency check failed", findingData)
            } else if (finding.status === "unsupported") {
              jsonLogger.warn(
                LOG_SCOPE,
                "Currency check is unsupported",
                findingData
              )
            }
          }

          jsonLogger.info(LOG_SCOPE, "Audit completed", {
            checked: result.checked,
            covered: result.covered,
            deficits: result.deficit,
            errors: result.error,
            event: "audit_completed",
            unsupported: result.unsupported,
          })
        } finally {
          await task.one("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
            DEPOSITORY_BALANCE_AUDIT_ADVISORY_LOCK_NAME,
          ])
        }
      })
    } catch (error) {
      jsonLogger.error(LOG_SCOPE, "Audit failed", {
        error,
        event: "audit_failed",
      })
    } finally {
      running = false
    }
  }

  void audit()
  const intervalMs = Math.max(
    60 * 1000,
    config.depositoryBalanceAuditIntervalMs
  )
  jsonLogger.info(LOG_SCOPE, "Audit scheduled", {
    event: "audit_scheduled",
    intervalMs,
  })
  setInterval(audit, intervalMs)
}
