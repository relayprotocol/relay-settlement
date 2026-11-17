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
import {
  processSingleLog,
  recordFailedEvent,
} from "./services/transferProcessor.js"
import { processTransferLogs } from "./services/transferBatch.js"
import {
  getLogPages,
  type IndexedLog,
  type LogRangeState,
} from "./services/logPages.js"
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
  logRange?: LogRangeState
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

  const processLogs = async (lane: Lane, logs: IndexedLog[]) => {
    if (lane.tokenContract) {
      const checkpoint = await getCheckpointValue(lane)
      await processTransferLogs(db, lane.tokenContract, logs, {
        checkpoint: checkpoint == null ? -1 : Number(checkpoint),
        contractAddress: lane.contractAddress,
        getTimestamp: (block) =>
          getBlockTimestamp(pollingProvider, cache, block),
        lane: lane.name,
      })
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
    lane.logRange ??= { blockCount: config.batchSize, successfulRanges: 0 }
    for await (const page of getLogPages(
      pollingProvider,
      {
        address: lane.contractAddress,
        fromBlock,
        toBlock,
        topics: lane.topics,
      },
      config.batchSize,
      lane.logRange
    )) {
      if (page.logs.length) {
        logger.info("indexer", "Processing log batch", {
          contractAddress: lane.contractAddress,
          count: page.logs.length,
          fromBlock: page.fromBlock,
          lane: lane.name,
          toBlock: page.toBlock,
        })
        await processLogs(lane, page.logs)
      }
      // Individual failures are in failed_events. Never checkpoint a partial
      // cursor range: recovery must reconcile its already-inserted events too.
      if (page.complete) await setLaneCheckpoint(lane, page.toBlock)
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
