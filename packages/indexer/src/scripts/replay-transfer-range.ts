import { RelayHub } from "@relay-protocol/settlement-abis"
import { Contract, Interface, JsonRpcProvider } from "ethers"
import { config } from "../config.js"
import { closeDb, openDb, type Queryable } from "../db/connection.js"
import {
  type ParsedTransferLog,
  insertEvent,
  parseTransferLog,
  reconcileTransferStateFromChain,
  shouldSkipTokenId,
  syncTokenTransfersFromEvents,
} from "../services/transferProcessor.js"
import { getBlockTimestamp } from "../services/utils.js"

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

const TRANSFER_REPLAY_LOCK_KEY = 1_021_026

const parseInteger = (
  name: string,
  options: {
    description: string
    fallback?: number
    min: number
  }
) => {
  const value = process.env[name]
  if (!value) {
    if (options.fallback == null) {
      throw new Error(`Missing required env var: ${name}`)
    }
    if (options.fallback < options.min) {
      throw new Error(
        `Invalid ${options.description} for ${name}: ${options.fallback}`
      )
    }
    return options.fallback
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < options.min) {
    throw new Error(`Invalid ${options.description} for ${name}: ${value}`)
  }
  return parsed
}

const parseBlock = (name: string, fallback?: number) =>
  parseInteger(name, {
    description: "block number",
    fallback,
    min: 0,
  })

const parsePositiveInteger = (name: string, fallback?: number) =>
  parseInteger(name, {
    description: "positive integer",
    fallback,
    min: 1,
  })

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

const withReplayLock = async <T>(
  db: Queryable,
  callback: (_db: Queryable) => Promise<T>
) => {
  const row = await db.one<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [TRANSFER_REPLAY_LOCK_KEY]
  )

  if (!row.acquired) {
    throw new Error("Another transfer replay is already running")
  }

  try {
    return await callback(db)
  } finally {
    await db.one("SELECT pg_advisory_unlock($1)", [TRANSFER_REPLAY_LOCK_KEY])
  }
}

const main = async () => {
  if (!config.rpcHttpUrl) {
    throw new Error("RPC_HTTP_URL is required for transfer replay")
  }

  const provider = new JsonRpcProvider(config.rpcHttpUrl)
  const latestBlock = await provider.getBlockNumber()
  const fromBlock = parseBlock("TRANSFER_REPLAY_FROM_BLOCK")
  const toBlock = parseBlock("TRANSFER_REPLAY_TO_BLOCK", latestBlock)
  const batchSize = parsePositiveInteger(
    "TRANSFER_REPLAY_BATCH_SIZE",
    config.batchSize
  )
  const reconcileChunkSize = parsePositiveInteger(
    "TRANSFER_REPLAY_RECONCILE_CHUNK",
    100
  )

  if (fromBlock > toBlock) {
    throw new Error(
      `TRANSFER_REPLAY_FROM_BLOCK (${fromBlock}) must be <= TRANSFER_REPLAY_TO_BLOCK (${toBlock})`
    )
  }

  const relayHubInterface = new Interface(RelayHub)
  const transferTopic = relayHubInterface.getEvent("Transfer")?.topicHash
  if (!transferTopic) {
    throw new Error("Transfer event topic hash not found in ABI")
  }

  const db = await openDb()
  const hubContract = new Contract(
    config.hubContractAddress,
    RelayHub,
    provider
  )
  const timestampCache = new Map<number, number>()

  let decoded = 0
  let inserted = 0
  let skipped = 0
  let reconciledAddresses = 0

  try {
    await db.task((taskDb) =>
      withReplayLock(taskDb, async (lockedDb) => {
        for (let start = fromBlock; start <= toBlock; start += batchSize) {
          const end = Math.min(start + batchSize - 1, toBlock)
          const logs = (await provider.getLogs({
            address: config.hubContractAddress,
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
              skipped += 1
              continue
            }

            if (shouldSkipTokenId(transfer.tokenId)) {
              skipped += 1
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

              decoded += 1
              inserted += wasInserted
            }
          })

          for (const [tokenId, addresses] of touched) {
            for (const addressChunk of chunk(
              [...addresses],
              reconcileChunkSize
            )) {
              await lockedDb.tx((tx) =>
                reconcileTransferStateFromChain(
                  tx,
                  hubContract,
                  tokenId,
                  addressChunk
                )
              )
              reconciledAddresses += addressChunk.length
            }
          }

          for (const tokenId of touchedTokens) {
            await syncTokenTransfersFromEvents(lockedDb, tokenId)
          }

          console.info(
            JSON.stringify({
              decoded,
              fromBlock: start,
              inserted,
              reconciledAddresses,
              skipped,
              toBlock: end,
            })
          )
        }
      })
    )
  } finally {
    await closeDb()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
