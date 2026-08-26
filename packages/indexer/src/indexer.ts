import { RelayHub, RelayOracle } from "@relay-protocol/settlement-abis"
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Provider,
  WebSocketProvider,
} from "ethers"
import { config } from "./config.js"
import { Database } from "./db/connection.js"
import { getMeta, setMeta } from "./db/meta.js"
import {
  HUB_ROLE_META_KEY,
  HUB_TRANSFER_META_KEY,
  LEGACY_HUB_ROLE_META_KEY,
  LEGACY_HUB_TRANSFER_META_KEY,
  ORACLE_EXECUTION_META_KEY,
  ORACLE_ROLE_META_KEY,
} from "./indexerState.js"
import { getBlockTimestamp } from "./services/utils.js"
import { getProtocolTransferType } from "./protocol/transferSemantics.js"
import {
  insertParsedTransferLog,
  parseTransferLog,
  processSingleLog,
  recordFailedEvent,
  reconcileTransferStateFromChain,
  shouldSkipTokenId,
  syncTokenTransfersFromEvents,
} from "./services/transferProcessor.js"
import {
  OracleExecutionProcessingContext,
  processAndStoreOracleExecutionLog,
} from "./services/oracleExecutionProcessor.js"
import { logger } from "./logger.js"

const relayHubInterface = new Interface(RelayHub)
const relayOracleInterface = new Interface(RelayOracle)
const PROCESSING_YIELD_INTERVAL = 100

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

type IndexedLog = {
  blockNumber: number
  transactionHash: string
  index: number
  topics: readonly string[]
  data: string
}

type Lane = {
  name: string
  contractAddress: string
  checkpointOverlapBlocks?: number
  topics: string[][]
  metaKey: string
  legacyMetaKey?: string
  startBlock: number
  processLog?: (_log: IndexedLog, _timestamp: number) => Promise<void>
  afterBatch?: () => void
  tokenContract?: Contract
}

export const backfillAndWatch = async (db: Database) => {
  const wsProvider = new WebSocketProvider(config.rpcWsUrl as string)
  const pollingProvider: Provider = config.rpcHttpUrl
    ? new JsonRpcProvider(config.rpcHttpUrl)
    : wsProvider
  const hubContract = new Contract(
    config.hubContractAddress,
    RelayHub,
    pollingProvider
  )

  const transferTopic = relayHubInterface.getEvent("Transfer")?.topicHash
  if (!transferTopic) {
    throw new Error("Transfer event topic hash not found in ABI")
  }
  const roleGrantedTopic = relayHubInterface.getEvent("RoleGranted")?.topicHash
  const roleRevokedTopic = relayHubInterface.getEvent("RoleRevoked")?.topicHash
  const roleAdminChangedTopic =
    relayHubInterface.getEvent("RoleAdminChanged")?.topicHash
  const oracleExecutedTopic =
    relayOracleInterface.getEvent("Executed")?.topicHash
  const oracleExecutionFailedTopic =
    relayOracleInterface.getEvent("ExecutionFailed")?.topicHash
  if (!roleGrantedTopic || !roleRevokedTopic || !roleAdminChangedTopic) {
    throw new Error("AccessControl event topic hash not found in ABI")
  }
  if (!oracleExecutedTopic || !oracleExecutionFailedTopic) {
    throw new Error("Oracle execution event topic hash not found in ABI")
  }

  const roleTopics = [
    [roleGrantedTopic, roleRevokedTopic, roleAdminChangedTopic],
  ]
  const oracleExecutionContext: OracleExecutionProcessingContext = {
    oracleContractAddress: config.oracleContractAddress,
    provider: pollingProvider,
    transactionCache: new Map(),
  }
  const lanes: Lane[] = [
    {
      checkpointOverlapBlocks: config.transferOverlapBlocks,
      contractAddress: config.hubContractAddress,
      legacyMetaKey: LEGACY_HUB_TRANSFER_META_KEY,
      metaKey: HUB_TRANSFER_META_KEY,
      name: "hub-transfers",
      startBlock: config.hubStartBlock,
      tokenContract: hubContract,
      topics: [[transferTopic]],
    },
    // Prioritize the protocol data path before slower role-history backfills.
    {
      afterBatch: () => {
        oracleExecutionContext.transactionCache.clear()
      },
      contractAddress: config.oracleContractAddress,
      metaKey: ORACLE_EXECUTION_META_KEY,
      name: "oracle-executions",
      processLog: (log, timestamp) =>
        processAndStoreOracleExecutionLog(
          db,
          oracleExecutionContext,
          log,
          timestamp
        ).then(() => undefined),
      startBlock: config.oracleStartBlock,
      topics: [[oracleExecutedTopic, oracleExecutionFailedTopic]],
    },
    {
      contractAddress: config.hubContractAddress,
      legacyMetaKey: LEGACY_HUB_ROLE_META_KEY,
      metaKey: HUB_ROLE_META_KEY,
      name: "hub-roles",
      processLog: (log, timestamp) =>
        processSingleLog(
          db,
          {
            contractAddress: config.hubContractAddress,
          },
          log,
          timestamp
        ),
      startBlock: 0,
      topics: roleTopics,
    },
    {
      contractAddress: config.oracleContractAddress,
      metaKey: ORACLE_ROLE_META_KEY,
      name: "oracle-roles",
      processLog: (log, timestamp) =>
        processSingleLog(
          db,
          {
            contractAddress: config.oracleContractAddress,
          },
          log,
          timestamp
        ),
      startBlock: 0,
      topics: roleTopics,
    },
  ]

  const cache = new Map<number, number>()
  if (!config.rpcHttpUrl) {
    logger.warn("indexer", "RPC_HTTP_URL not set; polling uses WebSocket RPC")
  }

  const errorMessage = (error: unknown) => {
    if (error instanceof Error) {
      return error.message
    }

    try {
      const serialized = JSON.stringify(error)
      if (typeof serialized === "string") {
        return serialized
      }
    } catch {
      return String(error)
    }

    return String(error)
  }

  const isResponseSizeError = (error: unknown): boolean => {
    return errorMessage(error)
      .toLowerCase()
      .includes("response size exceeds limit")
  }

  const toHex = (n: number) => "0x" + n.toString(16)

  const processLogs = async (lane: Lane, logs: IndexedLog[]) => {
    if (lane.tokenContract) {
      await processTransferLogs(lane, logs, lane.tokenContract)
      lane.afterBatch?.()
      return
    }

    if (!lane.processLog) {
      throw new Error(`Lane ${lane.name} is missing a log processor`)
    }

    for (const [batchIndex, log] of logs.entries()) {
      try {
        const timestamp = await getBlockTimestamp(
          pollingProvider,
          cache,
          log.blockNumber
        )
        await lane.processLog(log, timestamp)
      } catch (error) {
        logger.error(
          "indexer",
          "Failed to process log; recorded in failed_events",
          {
            blockNumber: log.blockNumber,
            contractAddress: lane.contractAddress,
            error,
            lane: lane.name,
            logIndex: log.index,
            txHash: log.transactionHash,
          }
        )
        await recordFailedEvent(db, lane.contractAddress, log, error)
      } finally {
        if ((batchIndex + 1) % PROCESSING_YIELD_INTERVAL === 0) {
          await yieldToEventLoop()
        }
      }
    }

    lane.afterBatch?.()
  }

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

  const processTransferLogs = async (
    lane: Lane,
    logs: IndexedLog[],
    tokenContract: Contract
  ) => {
    const checkpoint = await getCheckpointValue(lane)
    const parsedCheckpoint = checkpoint == null ? -1 : Number(checkpoint)
    const touched = new Map<string, Map<string, number>>()
    const touchedLogsByToken = new Map<string, IndexedLog[]>()

    for (const [batchIndex, log] of logs.entries()) {
      try {
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

        const timestamp = await getBlockTimestamp(
          pollingProvider,
          cache,
          log.blockNumber
        )
        const { inserted } = await db.tx((tx) =>
          insertParsedTransferLog(tx, transfer, log, timestamp)
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
            contractAddress: lane.contractAddress,
            error,
            lane: lane.name,
            logIndex: log.index,
            txHash: log.transactionHash,
          }
        )
        await recordFailedEvent(db, lane.contractAddress, log, error)
      } finally {
        if ((batchIndex + 1) % PROCESSING_YIELD_INTERVAL === 0) {
          await yieldToEventLoop()
        }
      }
    }

    for (const [tokenId, addressesByTimestamp] of touched) {
      const touchedLogs = touchedLogsByToken.get(tokenId) ?? []
      let tokenFailed = false

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
        tokenFailed = true
        for (const log of touchedLogs) {
          await recordFailedEvent(db, lane.contractAddress, log, error)
        }
        logger.error(
          "indexer",
          "Failed to reconcile transfer token; recorded token logs in failed_events",
          {
            error,
            lane: lane.name,
            tokenId,
            touchedLogs: touchedLogs.length,
          }
        )
      }

      try {
        await syncTokenTransfersFromEvents(db, tokenId)
      } catch (error) {
        if (!tokenFailed) {
          for (const log of touchedLogs) {
            await recordFailedEvent(db, lane.contractAddress, log, error)
          }
        }
        logger.error(
          "indexer",
          "Failed to sync transfer count; recorded token logs in failed_events",
          {
            error,
            lane: lane.name,
            tokenId,
            touchedLogs: touchedLogs.length,
          }
        )
      }

      await yieldToEventLoop()
    }
  }

  const fetchLogsWithCursor = async (
    lane: Lane,
    start: number,
    end: number
  ) => {
    logger.info("indexer", "Using eth_getLogsWithCursor for dense range", {
      contractAddress: lane.contractAddress,
      fromBlock: start,
      lane: lane.name,
      toBlock: end,
    })
    const allLogs: IndexedLog[] = []
    let cursor: string | undefined
    do {
      const params: Record<string, unknown> = {
        address: lane.contractAddress,
        fromBlock: toHex(start),
        toBlock: toHex(end),
        topics: lane.topics,
      }
      if (cursor) {
        params.cursor = cursor
      }
      const result = await (pollingProvider as JsonRpcProvider).send(
        "eth_getLogsWithCursor",
        [params]
      )
      const logs: Array<{
        blockNumber: string
        transactionHash: string
        logIndex: string
        topics: string[]
        data: string
      }> = result.logs ?? []
      for (const log of logs) {
        allLogs.push({
          blockNumber: Number(log.blockNumber),
          data: log.data,
          index: Number(log.logIndex),
          topics: log.topics,
          transactionHash: log.transactionHash,
        })
      }
      cursor = result.cursor ?? undefined
      if (cursor) {
        logger.debug("indexer", "Cursor pagination continuing", {
          contractAddress: lane.contractAddress,
          fromBlock: start,
          lane: lane.name,
          logsSoFar: allLogs.length,
          toBlock: end,
        })
      }
    } while (cursor)
    return allLogs
  }

  const setLaneCheckpoint = async (lane: Lane, end: number) => {
    const checkpoint = await getCheckpointValue(lane)
    const parsedCheckpoint = checkpoint == null ? null : Number(checkpoint)
    const nextCheckpoint =
      parsedCheckpoint == null || !Number.isFinite(parsedCheckpoint)
        ? end
        : Math.max(parsedCheckpoint, end)

    await setMeta(db, lane.metaKey, String(nextCheckpoint))
  }

  const processRange = async (
    lane: Lane,
    fromBlock: number,
    toBlock: number
  ) => {
    const queue: Array<[number, number]> = [[fromBlock, toBlock]]
    while (queue.length) {
      const [start, end] = queue.shift() as [number, number]
      try {
        const logs = await pollingProvider.getLogs({
          address: lane.contractAddress,
          fromBlock: start,
          toBlock: end,
          topics: lane.topics,
        })
        if (logs.length) {
          logger.info("indexer", "Processing log batch", {
            contractAddress: lane.contractAddress,
            count: logs.length,
            fromBlock: start,
            lane: lane.name,
            toBlock: end,
          })
          await processLogs(lane, logs)
        }
        // Failed logs are persisted into failed_events for follow-up handling.
        // The main checkpoint still advances so one bad log does not stall the lane.
        await setLaneCheckpoint(lane, end)
      } catch (error) {
        if (isResponseSizeError(error)) {
          if (start < end) {
            const mid = Math.floor((start + end) / 2)
            logger.warn(
              "indexer",
              "Splitting log range after oversized response",
              {
                contractAddress: lane.contractAddress,
                fromBlock: start,
                lane: lane.name,
                nextLeft: [start, mid],
                nextRight: [mid + 1, end],
                toBlock: end,
              }
            )
            queue.unshift([mid + 1, end])
            queue.unshift([start, mid])
            continue
          }
          const logs = await fetchLogsWithCursor(lane, start, end)
          if (logs.length) {
            logger.info("indexer", "Processing cursor-paginated batch", {
              contractAddress: lane.contractAddress,
              count: logs.length,
              fromBlock: start,
              lane: lane.name,
              toBlock: end,
            })
            await processLogs(lane, logs)
          }
          await setLaneCheckpoint(lane, end)
          continue
        }
        throw error
      }
    }
  }

  const getCheckpointValue = async (lane: Lane) => {
    const checkpoint = await getMeta(db, lane.metaKey)
    if (checkpoint) {
      return checkpoint
    }
    if (lane.legacyMetaKey) {
      return getMeta(db, lane.legacyMetaKey)
    }
    return null
  }

  const getNextStartBlock = async (lane: Lane) => {
    const checkpoint = await getCheckpointValue(lane)
    if (!checkpoint) {
      return lane.startBlock
    }

    const parsedCheckpoint = Number(checkpoint)
    if (!Number.isInteger(parsedCheckpoint) || parsedCheckpoint < 0) {
      throw new Error(
        `Invalid checkpoint for lane ${lane.name} (${lane.metaKey}): ${checkpoint}`
      )
    }

    return Math.max(
      lane.startBlock,
      parsedCheckpoint + 1 - (lane.checkpointOverlapBlocks ?? 0)
    )
  }

  const processLaneUntil = async (lane: Lane, latestBlock: number) => {
    let currentBlock = await getNextStartBlock(lane)
    if (currentBlock > latestBlock) {
      return
    }

    logger.info("indexer", "Lane backfill start", {
      batchSize: config.batchSize,
      contractAddress: lane.contractAddress,
      lane: lane.name,
      latestBlock,
      startBlock: currentBlock,
    })

    while (currentBlock <= latestBlock) {
      const toBlock = Math.min(currentBlock + config.batchSize - 1, latestBlock)
      await processRange(lane, currentBlock, toBlock)
      currentBlock = toBlock + 1
    }
  }

  const chainLatestBlock = await pollingProvider.getBlockNumber()
  const latestBlock = Math.max(0, chainLatestBlock - config.confirmationBlocks)
  logger.info("indexer", "Backfill start", {
    batchSize: config.batchSize,
    chainLatestBlock,
    confirmationBlocks: config.confirmationBlocks,
    laneCount: lanes.length,
    latestBlock,
  })
  for (const lane of lanes) {
    await processLaneUntil(lane, latestBlock)
  }
  logger.info("indexer", "Backfill complete", { lastBlock: latestBlock })

  let polling = false
  const poll = async () => {
    if (polling) return
    polling = true
    try {
      const chainLatest = await pollingProvider.getBlockNumber()
      const latest = Math.max(0, chainLatest - config.confirmationBlocks)
      for (const lane of lanes) {
        await processLaneUntil(lane, latest)
      }
    } catch (error) {
      logger.error("indexer", "Polling failed", { error })
    } finally {
      polling = false
    }
  }

  void poll()
  logger.info("indexer", "Polling scheduled", {
    intervalMs: config.pollIntervalMs,
  })
  setInterval(poll, config.pollIntervalMs)

  wsProvider.on("block", () => {
    void poll()
  })

  try {
    wsProvider.on("error", (error) => {
      logger.error("indexer", "WebSocket provider error", { error })
    })
  } catch {
    logger.warn("indexer", "Provider does not support error events.")
  }
}
