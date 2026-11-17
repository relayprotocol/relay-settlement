import { setImmediate } from "node:timers/promises"
import type { JsonRpcProvider, Provider } from "ethers"

export const LOG_PAGE_SIZE = 1000

export type IndexedLog = {
  blockNumber: number
  transactionHash: string
  index: number
  topics: readonly string[]
  data: string
}

type RpcLog = Omit<IndexedLog, "blockNumber" | "index"> & {
  blockNumber: number | string
  index?: number
  logIndex?: number | string
}

export type LogRangeState = {
  blockCount: number
  successfulRanges: number
}

export type LogPage = {
  logs: IndexedLog[]
  fromBlock: number
  toBlock: number
  complete: boolean
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const isGetLogsResponseTooLargeError = (error: unknown): boolean => {
  if (!isObject(error)) return false
  const messages = [error.message, error.shortMessage, error.reason]
  // RPC code -32005 also covers rate limits; only split explicit size errors.
  return (
    messages.some(
      (message) =>
        typeof message === "string" &&
        message.toLowerCase().includes("response size exceeds limit")
    ) || isGetLogsResponseTooLargeError(error.error)
  )
}

// Bound sorting/normalization work even if a provider returns a large cursor page.
async function* chunks(logs: RpcLog[]): AsyncGenerator<IndexedLog[]> {
  for (let offset = 0; offset < logs.length; offset += LOG_PAGE_SIZE) {
    yield logs
      .slice(offset, offset + LOG_PAGE_SIZE)
      .map((log) => ({
        blockNumber: Number(log.blockNumber),
        data: log.data,
        index: Number(log.index ?? log.logIndex ?? 0),
        topics: log.topics,
        transactionHash: log.transactionHash,
      }))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    await setImmediate()
  }
}

// Retain only one response at a time. A range is checkpointable only after its
// final page; a cursor failure must leave a partially processed block replayable.
export async function* getLogPages(
  provider: Provider,
  filter: {
    address: string
    fromBlock: number
    toBlock: number
    topics: Array<string | string[] | null>
  },
  maxBlockCount: number,
  state: LogRangeState = { blockCount: maxBlockCount, successfulRanges: 0 }
): AsyncGenerator<LogPage> {
  if (!Number.isInteger(maxBlockCount) || maxBlockCount < 1) {
    throw new Error("Log block batch size must be a positive integer")
  }
  let start = filter.fromBlock
  while (start <= filter.toBlock) {
    const end = Math.min(start + state.blockCount - 1, filter.toBlock)
    let logs: RpcLog[] | undefined
    try {
      logs = await provider.getLogs({
        ...filter,
        fromBlock: start,
        toBlock: end,
      })
    } catch (error) {
      if (!isGetLogsResponseTooLargeError(error)) throw error
    }

    if ((!logs || logs.length > LOG_PAGE_SIZE) && start < end) {
      state.blockCount = Math.max(1, Math.floor((end - start + 1) / 2))
      state.successfulRanges = 0
      continue
    }

    if (logs) {
      let processed = 0
      for await (const chunk of chunks(logs)) {
        processed += chunk.length
        yield {
          complete: processed === logs.length,
          fromBlock: start,
          logs: chunk,
          toBlock: end,
        }
      }
      if (!logs.length)
        yield { complete: true, fromBlock: start, logs: [], toBlock: end }
      if (
        end - start + 1 === state.blockCount &&
        logs.length < LOG_PAGE_SIZE / 2
      ) {
        if (++state.successfulRanges >= 32) {
          state.blockCount = Math.min(maxBlockCount, state.blockCount * 2)
          state.successfulRanges = 0
        }
      } else {
        state.successfulRanges = 0
      }
    } else {
      let cursor: string | undefined
      do {
        const result = (await (provider as JsonRpcProvider).send(
          "eth_getLogsWithCursor",
          [
            {
              ...filter,
              fromBlock: `0x${start.toString(16)}`,
              toBlock: `0x${end.toString(16)}`,
              ...(cursor ? { cursor } : {}),
            },
          ]
        )) as { cursor?: string | null; logs?: RpcLog[] }
        const nextCursor = result.cursor ?? undefined
        if (nextCursor && nextCursor === cursor)
          throw new Error("Log cursor did not advance")
        const pageLogs = result.logs ?? []
        let processed = 0
        for await (const chunk of chunks(pageLogs)) {
          processed += chunk.length
          yield {
            complete: !nextCursor && processed === pageLogs.length,
            fromBlock: start,
            logs: chunk,
            toBlock: end,
          }
        }
        if (!pageLogs.length)
          yield {
            complete: !nextCursor,
            fromBlock: start,
            logs: [],
            toBlock: end,
          }
        cursor = nextCursor
        await setImmediate()
      } while (cursor)
    }
    start = end + 1
  }
}
