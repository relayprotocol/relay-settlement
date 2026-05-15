import { RelayHub } from "@relay-protocol/settlement-abis"
import { Contract, Interface, type Provider } from "ethers"
import type { Database, Queryable } from "../db/connection.js"
import {
  type ParsedTransferLog,
  insertEvent,
  parseTransferLog,
  reconcileTransferStateFromChain,
  shouldSkipTokenId,
  syncTokenTransfersFromEvents,
} from "./transferProcessor.js"
import { getBlockTimestamp } from "./utils.js"

type IndexedLog = {
  blockNumber: number
  transactionHash: string
  index: number
  topics: readonly string[]
  data: string
}

type ReplayTransfer = {
  log: IndexedLog
  timestamp: number
  transfer: ParsedTransferLog
}

export type TransferReplayRequest = {
  batchSize: number
  fromBlock: number
  reconcileChunkSize: number
  toBlock: number
}

export type TransferReplayProgress = {
  blocksPerSecond: number | null
  currentBlock: number | null
  decoded: number
  elapsedMs: number
  estimatedRemainingSeconds: number | null
  fromBlock: number
  inserted: number
  lastBatchFromBlock: number | null
  lastBatchToBlock: number | null
  percentComplete: number
  processedBlocks: number
  reconciledAddresses: number
  remainingBlocks: number
  skipped: number
  toBlock: number
  totalBlocks: number
  updatedAt: string
}

export class TransferReplayRequestError extends Error {}
export class TransferReplayConflictError extends Error {}

const TRANSFER_REPLAY_LOCK_KEY = 1_021_026

type TransferReplayCounters = {
  decoded: number
  inserted: number
  reconciledAddresses: number
  skipped: number
}

const addTouchedAddress = (
  touched: Map<string, Set<string>>,
  tokenId: string,
  address: string
) => {
  const lower = address.toLowerCase()
  let addresses = touched.get(tokenId)
  if (!addresses) {
    addresses = new Set()
    touched.set(tokenId, addresses)
  }
  addresses.add(lower)
}

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

export const buildTransferReplayProgress = (
  request: TransferReplayRequest,
  counters: TransferReplayCounters,
  startedAtMs: number,
  completed: {
    currentBlock: number | null
    lastBatchFromBlock: number | null
    lastBatchToBlock: number | null
  }
): TransferReplayProgress => {
  const totalBlocks = request.toBlock - request.fromBlock + 1
  const processedBlocks =
    completed.currentBlock == null
      ? 0
      : Math.max(
          0,
          Math.min(completed.currentBlock, request.toBlock) -
            request.fromBlock +
            1
        )
  const remainingBlocks = totalBlocks - processedBlocks
  const elapsedMs = Math.max(0, Date.now() - startedAtMs)
  const blocksPerSecond =
    elapsedMs > 0 && processedBlocks > 0
      ? processedBlocks / (elapsedMs / 1000)
      : null
  const estimatedRemainingSeconds =
    remainingBlocks === 0
      ? 0
      : blocksPerSecond == null
        ? null
        : remainingBlocks / blocksPerSecond

  return {
    blocksPerSecond,
    currentBlock: completed.currentBlock,
    decoded: counters.decoded,
    elapsedMs,
    estimatedRemainingSeconds,
    fromBlock: request.fromBlock,
    inserted: counters.inserted,
    lastBatchFromBlock: completed.lastBatchFromBlock,
    lastBatchToBlock: completed.lastBatchToBlock,
    percentComplete: (processedBlocks / totalBlocks) * 100,
    processedBlocks,
    reconciledAddresses: counters.reconciledAddresses,
    remainingBlocks,
    skipped: counters.skipped,
    toBlock: request.toBlock,
    totalBlocks,
    updatedAt: new Date().toISOString(),
  }
}

const withReplayLock = async <T>(
  db: Queryable,
  callback: (_db: Queryable) => Promise<T>
) => {
  const row = await db.one<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [TRANSFER_REPLAY_LOCK_KEY]
  )

  if (!row.acquired) {
    throw new TransferReplayConflictError(
      "Another transfer replay is already running"
    )
  }

  try {
    return await callback(db)
  } finally {
    await db.one("SELECT pg_advisory_unlock($1)", [TRANSFER_REPLAY_LOCK_KEY])
  }
}

export const validateTransferReplayRequest = (
  request: TransferReplayRequest,
  options: {
    maxBlockRange?: number
  } = {}
) => {
  const integerFields: Array<keyof TransferReplayRequest> = [
    "batchSize",
    "fromBlock",
    "reconcileChunkSize",
    "toBlock",
  ]

  for (const field of integerFields) {
    if (!Number.isInteger(request[field])) {
      throw new TransferReplayRequestError(`${field} must be an integer`)
    }
  }

  if (request.fromBlock < 0 || request.toBlock < 0) {
    throw new TransferReplayRequestError("block numbers must be >= 0")
  }

  if (request.batchSize < 1) {
    throw new TransferReplayRequestError("batchSize must be >= 1")
  }

  if (request.reconcileChunkSize < 1) {
    throw new TransferReplayRequestError("reconcileChunkSize must be >= 1")
  }

  if (request.fromBlock > request.toBlock) {
    throw new TransferReplayRequestError(
      `fromBlock (${request.fromBlock}) must be <= toBlock (${request.toBlock})`
    )
  }

  if (options.maxBlockRange != null) {
    const blockRange = request.toBlock - request.fromBlock + 1
    if (blockRange > options.maxBlockRange) {
      throw new TransferReplayRequestError(
        `block range (${blockRange}) exceeds maxBlockRange (${options.maxBlockRange})`
      )
    }
  }
}

export const buildTransferReplayRequest = (
  input: Record<string, unknown>,
  defaults: {
    batchSize: number
    reconcileChunkSize: number
  },
  options: {
    maxBlockRange?: number
  } = {}
): TransferReplayRequest => {
  const parseInteger = (name: string, value: unknown) => {
    if (
      typeof value !== "number" &&
      (typeof value !== "string" || value.trim() === "")
    ) {
      throw new TransferReplayRequestError(`${name} must be an integer`)
    }

    const parsed = Number(value)
    if (!Number.isInteger(parsed)) {
      throw new TransferReplayRequestError(`${name} must be an integer`)
    }
    return parsed
  }

  const readRequiredInteger = (name: string) => {
    const value = input[name]
    if (value == null) {
      throw new TransferReplayRequestError(`${name} is required`)
    }
    return parseInteger(name, value)
  }

  const readOptionalInteger = (name: string, fallback: number) => {
    const value = input[name]
    if (value == null) {
      return fallback
    }

    return parseInteger(name, value)
  }

  const request = {
    batchSize: readOptionalInteger("batchSize", defaults.batchSize),
    fromBlock: readRequiredInteger("fromBlock"),
    reconcileChunkSize: readOptionalInteger(
      "reconcileChunkSize",
      defaults.reconcileChunkSize
    ),
    toBlock: readRequiredInteger("toBlock"),
  }

  validateTransferReplayRequest(request, options)
  return request
}

export const runTransferReplay = async (
  db: Database,
  provider: Provider,
  hubContract: Contract,
  request: TransferReplayRequest,
  options: {
    onProgress?: (_progress: TransferReplayProgress) => void
  } = {}
) => {
  validateTransferReplayRequest(request)

  const relayHubInterface = new Interface(RelayHub)
  const transferTopic = relayHubInterface.getEvent("Transfer")?.topicHash
  if (!transferTopic) {
    throw new Error("Transfer event topic hash not found in ABI")
  }

  const timestampCache = new Map<number, number>()
  const startedAtMs = Date.now()
  const counters = {
    decoded: 0,
    inserted: 0,
    reconciledAddresses: 0,
    skipped: 0,
  }
  const completed = {
    currentBlock: null as number | null,
    lastBatchFromBlock: null as number | null,
    lastBatchToBlock: null as number | null,
  }

  await db.task((taskDb) =>
    withReplayLock(taskDb, async (lockedDb) => {
      for (
        let start = request.fromBlock;
        start <= request.toBlock;
        start += request.batchSize
      ) {
        const end = Math.min(start + request.batchSize - 1, request.toBlock)
        const logs = (await provider.getLogs({
          address: hubContract.target as string,
          fromBlock: start,
          toBlock: end,
          topics: [[transferTopic]],
        })) as IndexedLog[]

        const touched = new Map<string, Set<string>>()
        const touchedTokens = new Set<string>()
        const replayTransfers: ReplayTransfer[] = []

        for (const log of logs.sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.index - b.index
            : a.blockNumber - b.blockNumber
        )) {
          const transfer = parseTransferLog(log)
          if (!transfer) {
            counters.skipped += 1
            continue
          }

          if (shouldSkipTokenId(transfer.tokenId)) {
            counters.skipped += 1
            continue
          }

          const timestamp = await getBlockTimestamp(
            provider,
            timestampCache,
            log.blockNumber
          )
          replayTransfers.push({ log, timestamp, transfer })
          touchedTokens.add(transfer.tokenId)
          addTouchedAddress(touched, transfer.tokenId, transfer.from)
          addTouchedAddress(touched, transfer.tokenId, transfer.to)
        }

        await lockedDb.tx(async (tx) => {
          for (const { log, timestamp, transfer } of replayTransfers) {
            const wasInserted = await insertEvent(tx, {
              amount: transfer.amount.toString(),
              blockNumber: log.blockNumber,
              from: transfer.from,
              index: log.index,
              operator: transfer.operator,
              timestamp,
              to: transfer.to,
              tokenId: transfer.tokenId,
              transactionHash: log.transactionHash,
            })

            counters.decoded += 1
            counters.inserted += wasInserted
          }
        })

        for (const [tokenId, addresses] of touched) {
          for (const addressChunk of chunk(
            [...addresses],
            request.reconcileChunkSize
          )) {
            await lockedDb.tx((tx) =>
              reconcileTransferStateFromChain(
                tx,
                hubContract,
                tokenId,
                addressChunk
              )
            )
            counters.reconciledAddresses += addressChunk.length
          }
        }

        for (const tokenId of touchedTokens) {
          await syncTokenTransfersFromEvents(lockedDb, tokenId)
        }

        completed.currentBlock = end
        completed.lastBatchFromBlock = start
        completed.lastBatchToBlock = end
        options.onProgress?.(
          buildTransferReplayProgress(request, counters, startedAtMs, completed)
        )
      }
    })
  )

  return buildTransferReplayProgress(request, counters, startedAtMs, completed)
}
