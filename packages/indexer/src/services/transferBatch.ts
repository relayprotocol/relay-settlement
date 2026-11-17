import type { Contract } from "ethers"
import type { Database } from "../db/connection.js"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"
import { logger } from "../logger.js"
import { getProtocolTransferType } from "../protocol/transferSemantics.js"
import type { IndexedLog } from "./logPages.js"
import { getEventKey, getIndexedEventKeys } from "./indexedEvents.js"
import {
  ensureToken,
  insertParsedTransferLog,
  parseTransferLog,
  recordFailedEvent,
  reconcileTransferStateFromChain,
  shouldSkipTokenId,
} from "./transferProcessor.js"

const PROCESSING_YIELD_INTERVAL = 100

const addTouchedAddress = (
  touched: Map<string, Map<string, number>>,
  tokenId: string,
  address: string,
  timestamp: number
) => {
  const normalizedAddress = address.toLowerCase()
  let addressesByTimestamp = touched.get(tokenId)
  if (!addressesByTimestamp) {
    addressesByTimestamp = new Map()
    touched.set(tokenId, addressesByTimestamp)
  }

  addressesByTimestamp.set(
    normalizedAddress,
    Math.max(addressesByTimestamp.get(normalizedAddress) ?? 0, timestamp)
  )
}

export const processTransferLogs = async (
  db: Database,
  tokenContract: Contract,
  logs: IndexedLog[],
  options: {
    checkpoint: number
    contractAddress: string
    getTimestamp: (_block: number) => Promise<number>
    lane: string
  }
) => {
  const parsedCheckpoint = options.checkpoint
  const indexedKeys = await getIndexedEventKeys(db, logs)
  const preparedTokens = new Set<string>()
  const touched = new Map<string, Map<string, number>>()
  const touchedLogsByToken = new Map<string, IndexedLog[]>()

  for (const [batchIndex, log] of logs.entries()) {
    try {
      const eventKey = getEventKey(log)
      // A committed overlap duplicate needs no processing. Above-checkpoint
      // events can have survived a crash before state reconciliation completed.
      if (log.blockNumber <= parsedCheckpoint && indexedKeys.has(eventKey))
        continue
      const transfer = parseTransferLog(log)
      if (!transfer) {
        logger.warn("processor", "Skipping undecodable transfer log", {
          blockNumber: log.blockNumber,
          logIndex: log.index,
          txHash: log.transactionHash,
        })
        continue
      }

      if (shouldSkipTokenId(transfer.tokenId)) {
        logger.info("processor", "Skipping transfer for token", {
          blockNumber: log.blockNumber,
          logIndex: log.index,
          tokenId: transfer.tokenId,
          txHash: log.transactionHash,
        })
        continue
      }

      const timestamp = await options.getTimestamp(log.blockNumber)
      if (!preparedTokens.has(transfer.tokenId)) {
        await ensureToken(db, tokenContract, transfer.tokenId)
        preparedTokens.add(transfer.tokenId)
      }
      const { inserted } = await insertParsedTransferLog(
        db,
        transfer,
        log,
        timestamp
      )

      if (inserted || log.blockNumber > parsedCheckpoint) {
        addTouchedAddress(touched, transfer.tokenId, transfer.from, timestamp)
        addTouchedAddress(touched, transfer.tokenId, transfer.to, timestamp)
        const touchedLogs = touchedLogsByToken.get(transfer.tokenId) ?? []
        touchedLogs.push(log)
        touchedLogsByToken.set(transfer.tokenId, touchedLogs)
      }

      if (inserted) {
        logger.debug("processor", "Transfer processed", {
          amount: transfer.amount.toString(),
          blockNumber: log.blockNumber,
          from: transfer.from,
          logIndex: log.index,
          operator: transfer.operator,
          to: transfer.to,
          tokenId: transfer.tokenId,
          txHash: log.transactionHash,
          type: getProtocolTransferType(transfer.from, transfer.to),
        })
      }
    } catch (error) {
      logger.error(
        "indexer",
        "Failed to process log; recorded in failed_events",
        {
          blockNumber: log.blockNumber,
          contractAddress: options.contractAddress,
          error,
          lane: options.lane,
          logIndex: log.index,
          txHash: log.transactionHash,
        }
      )
      await recordFailedEvent(db, options.contractAddress, log, error)
    } finally {
      if ((batchIndex + 1) % PROCESSING_YIELD_INTERVAL === 0) {
        await yieldToEventLoop()
      }
    }
  }

  for (const [tokenId, addressesByTimestamp] of touched) {
    const touchedLogs = touchedLogsByToken.get(tokenId) ?? []
    try {
      const groupedAddresses = new Map<number, string[]>()
      for (const [address, timestamp] of addressesByTimestamp) {
        const addresses = groupedAddresses.get(timestamp) ?? []
        addresses.push(address)
        groupedAddresses.set(timestamp, addresses)
      }

      for (const [timestamp, addresses] of groupedAddresses) {
        await reconcileTransferStateFromChain(
          db,
          tokenContract,
          tokenId,
          addresses,
          timestamp
        )
      }
    } catch (error) {
      for (const log of touchedLogs) {
        await recordFailedEvent(db, options.contractAddress, log, error)
      }
      logger.error(
        "indexer",
        "Failed to reconcile transfer token; recorded token logs in failed_events",
        {
          error,
          lane: options.lane,
          tokenId,
          touchedLogs: touchedLogs.length,
        }
      )
    }

    await yieldToEventLoop()
  }
}
