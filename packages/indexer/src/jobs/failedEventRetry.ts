import { Contract, Provider } from "ethers"
import type { Database } from "../db/connection.js"
import {
  insertRoleEvent,
  parseAccessControlLog,
  reconcileRoleStateFromChain,
} from "../services/accessControlProcessor.js"
import {
  OracleExecutionProcessingContext,
  parseOracleExecutionLog,
  processAndStoreOracleExecutionLog,
} from "../services/oracleExecutionProcessor.js"
import { runWithRetry } from "../services/retry.js"
import {
  incrementTokenTransfers,
  insertEvent,
  parseTransferLog,
  reconcileTransferStateFromChain,
  shouldSkipTokenId,
} from "../services/transferProcessor.js"
import { getBlockTimestamp } from "../services/utils.js"
import { logger } from "../logger.js"

type RetryContext = {
  hubContractAddress: string
  oracleContractAddress: string
  hubContract: Contract
  oracleContract: Contract
  oracleExecutionContext: OracleExecutionProcessingContext
}

export const startFailedEventRetry = (
  db: Database,
  provider: Provider,
  context: RetryContext,
  cache: Map<number, number>
) => {
  let running = false

  const retry = async () => {
    if (running) {
      logger.warn("retry", "Skipping overlapping failed event retry run")
      return
    }

    running = true
    logger.info("retry", "Failed event retry job started")

    try {
      const rows = await db.manyOrNone<{
        id: number
        contract_address: string
        block_number: number
        tx_hash: string
        log_index: number
        data: string
      }>(
        `SELECT id, contract_address, block_number, tx_hash, log_index, data
         FROM failed_events
         ORDER BY block_number ASC, log_index ASC
         LIMIT 200`
      )

      if (!rows.length) {
        return
      }

      for (const row of rows) {
        try {
          const parsedData = JSON.parse(row.data) as {
            topics: readonly string[]
            data: string
          }

          await processFailedLog(db, provider, context, cache, {
            blockNumber: row.block_number,
            contractAddress: row.contract_address,
            data: parsedData.data,
            index: row.log_index,
            topics: parsedData.topics,
            transactionHash: row.tx_hash,
          })

          await db.none("DELETE FROM failed_events WHERE id = $1", [row.id])
          logger.info("retry", "Failed event replayed", {
            blockNumber: row.block_number,
            logIndex: row.log_index,
            txHash: row.tx_hash,
          })
        } catch (error) {
          await db.none(
            "UPDATE failed_events SET retry_count = retry_count + 1, error = $1, updated_at = NOW() WHERE id = $2",
            [String(error), row.id]
          )
          logger.error("retry", "Failed event replay failed", {
            blockNumber: row.block_number,
            error,
            logIndex: row.log_index,
            txHash: row.tx_hash,
          })
        }
      }

      logger.info("retry", "Failed event retry job completed", {
        processed: rows.length,
      })
    } catch (error) {
      logger.error("retry", "Failed event retry job error", { error })
    } finally {
      running = false
    }
  }

  void retry()
  logger.info("retry", "Failed event retry scheduled", {
    intervalMs: 60 * 1000,
  })
  setInterval(retry, 60 * 1000)
}

const processFailedLog = async (
  db: Database,
  provider: Provider,
  context: RetryContext,
  cache: Map<number, number>,
  log: {
    contractAddress: string
    blockNumber: number
    transactionHash: string
    index: number
    topics: readonly string[]
    data: string
  }
) => {
  await runWithRetry(async () => {
    await db.tx(async (tx) => {
      const contractAddress = log.contractAddress.toLowerCase()
      const isKnownContract =
        contractAddress === context.hubContractAddress ||
        contractAddress === context.oracleContractAddress

      if (!isKnownContract) {
        throw new Error(
          `Unknown failed-event contract address: ${contractAddress}`
        )
      }

      const parsedTransfer =
        contractAddress === context.hubContractAddress
          ? parseTransferLog(log)
          : null
      const parsedOracleExecution =
        contractAddress === context.oracleContractAddress
          ? parseOracleExecutionLog(log)
          : null
      const parsedAccess =
        parsedTransfer || parsedOracleExecution
          ? null
          : parseAccessControlLog(log)

      if (!parsedTransfer && !parsedOracleExecution && !parsedAccess) {
        return
      }

      const timestamp = await getBlockTimestamp(
        provider,
        cache,
        log.blockNumber
      )

      if (parsedTransfer) {
        const operator = parsedTransfer.args.caller
        const from = parsedTransfer.args.from
        const to = parsedTransfer.args.to
        const id = parsedTransfer.args.id
        const amount = parsedTransfer.args.amount
        const tokenId = id.toString()

        if (shouldSkipTokenId(tokenId)) {
          logger.info("retry", "Skipping transfer replay for token", {
            blockNumber: log.blockNumber,
            logIndex: log.index,
            tokenId,
            txHash: log.transactionHash,
          })
          return
        }

        const inserted = await insertEvent(tx, {
          amount: amount.toString(),
          blockNumber: log.blockNumber,
          from,
          index: log.index,
          operator,
          timestamp,
          to,
          tokenId,
          transactionHash: log.transactionHash,
        })

        if (inserted) {
          await reconcileTransferStateFromChain(
            tx,
            context.hubContract,
            tokenId,
            [from, to],
            timestamp
          )
          await incrementTokenTransfers(tx, tokenId)
        }

        return
      }

      if (parsedOracleExecution) {
        await processAndStoreOracleExecutionLog(
          tx,
          context.oracleExecutionContext,
          log,
          timestamp
        )
        return
      }

      if (parsedAccess) {
        const inserted = await insertRoleEvent(
          tx,
          {
            blockNumber: log.blockNumber,
            contractAddress,
            index: log.index,
            timestamp,
            transactionHash: log.transactionHash,
          },
          parsedAccess
        )

        if (inserted) {
          const accessControlContract =
            contractAddress === context.hubContractAddress
              ? context.hubContract
              : context.oracleContract

          await reconcileRoleStateFromChain(
            tx,
            accessControlContract,
            contractAddress,
            parsedAccess
          )
        }
      }
    })
  })
}
