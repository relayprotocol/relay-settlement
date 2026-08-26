import { createHash } from "node:crypto"
import { MemoryCacheBackend, type CacheBackend } from "../cache.js"
import type { Database } from "../db/connection.js"
import { jsonLogger } from "../logger.js"
import type { EventRow, TransferStatRow } from "../models/db.js"

type EventsFilter = {
  tokenId?: string
  address?: string
  limit: number
  cursor?: string
}

const parseCursor = (cursor?: string) => {
  if (!cursor) return null
  const [blockStr, logStr] = cursor.split(":")
  const block = Number(blockStr)
  const log = Number(logStr)
  if (!Number.isFinite(block) || !Number.isFinite(log)) return null
  return { block, log }
}

export const listEvents = async (db: Database, filter: EventsFilter) => {
  const { tokenId, address, limit, cursor } = filter
  const where: string[] = []
  const params: Record<string, string | number> = { limit }

  if (tokenId) {
    where.push("token_id = $/tokenId/")
    params.tokenId = tokenId
  }
  if (address) {
    where.push("(from_addr = $/address/ OR to_addr = $/address/)")
    params.address = address
  }

  const parsedCursor = parseCursor(cursor)
  if (parsedCursor) {
    where.push(
      "(block_number < $/cursorBlock/ OR (block_number = $/cursorBlock/ AND log_index < $/cursorLog/))"
    )
    params.cursorBlock = parsedCursor.block
    params.cursorLog = parsedCursor.log
  }

  const rows = await db.manyOrNone<EventRow>(
    `SELECT block_number, tx_hash, log_index, operator, from_addr, to_addr, token_id, amount, timestamp
     FROM events
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY block_number DESC, log_index DESC
     LIMIT $/limit/`,
    params
  )

  const last = rows[rows.length - 1]
  const nextCursor =
    rows.length === limit && last
      ? `${last.block_number}:${last.log_index}`
      : null

  return { nextCursor, rows }
}

const TRANSFER_STATS_CACHE_TTL_MS = 10 * 60 * 1000
const TRANSFER_STATS_TIMEZONE = "UTC"

type TransferStatsGranularity = "day" | "hour" | "minute" | "month" | "week"

type TransferStatsArgs = {
  tokenId?: string
  granularity: string
  points: number
  tzOffsetMinutes: number
}

type TransferStatsCacheLogger = Pick<typeof jsonLogger, "debug" | "error">

const granularityConfig: Record<
  TransferStatsGranularity,
  { format: string; seconds: number }
> = {
  day: { format: "YYYY-MM-DD", seconds: 86400 },
  hour: { format: "YYYY-MM-DD HH24:00", seconds: 3600 },
  minute: { format: "YYYY-MM-DD HH24:MI", seconds: 60 },
  month: { format: "YYYY-MM", seconds: 2592000 },
  week: { format: "YYYY-MM-DD", seconds: 604800 },
}

const normalizeGranularity = (granularity: string): TransferStatsGranularity =>
  Object.prototype.hasOwnProperty.call(granularityConfig, granularity)
    ? (granularity as TransferStatsGranularity)
    : "day"

const normalizePoints = (points: number) =>
  Number.isFinite(points) && points > 0 ? Math.min(points, 365) : 30

const normalizeTzOffsetMinutes = (tzOffsetMinutes: number) =>
  Number.isFinite(tzOffsetMinutes) ? Math.trunc(tzOffsetMinutes) : 0

const buildBucketExpr = (
  granularity: TransferStatsGranularity,
  format: string
) => {
  const shiftedTs = `(to_timestamp(timestamp) AT TIME ZONE '${TRANSFER_STATS_TIMEZONE}' + make_interval(mins => $/tzOffsetMinutes/))`
  return `to_char(date_trunc('${granularity}', ${shiftedTs}), '${format}')`
}

const buildTransferStatsCacheKey = (input: {
  format: string
  granularity: TransferStatsGranularity
  points: number
  since: number
  tokenId: string | null
  timezone: string
  tzOffsetMinutes: number
}) => {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
  return `indexer:transfer-stats:v1:${digest}`
}

const parseCachedRows = (value: string): TransferStatRow[] => {
  const rows: unknown = JSON.parse(value)
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as TransferStatRow).bucket === "string" &&
        Number.isInteger((row as TransferStatRow).count)
    )
  ) {
    throw new Error("Invalid transfer stats cache value")
  }

  return rows as TransferStatRow[]
}

export const createTransferStatsService = (
  db: Database,
  options: {
    cache?: CacheBackend
    logger?: TransferStatsCacheLogger
    now?: () => number
  } = {}
) => {
  const cache = options.cache ?? new MemoryCacheBackend()
  const logger = options.logger ?? jsonLogger
  const now = options.now ?? Date.now
  const inFlight = new Map<string, Promise<TransferStatRow[]>>()

  const load = async (
    key: string,
    query: {
      bucketExpr: string
      since: number
      tokenId?: string
      tzOffsetMinutes: number
    }
  ) => {
    try {
      const cached = await cache.get(key)
      if (cached !== null) {
        const rows = parseCachedRows(cached)
        logger.debug("transfer-stats-cache", "Cache hit", { cacheKey: key })
        return rows
      }
    } catch (error) {
      logger.error("transfer-stats-cache", "Cache read failed", {
        cacheKey: key,
        error,
      })
    }

    logger.debug("transfer-stats-cache", "Cache miss", { cacheKey: key })

    const rows = await db.manyOrNone<TransferStatRow>(
      `SELECT ${query.bucketExpr} AS bucket, COUNT(*)::int AS count
       FROM events
       WHERE ${query.tokenId ? "token_id = $/tokenId/ AND " : ""}timestamp >= $/since/
       GROUP BY bucket
       ORDER BY bucket ASC`,
      {
        since: query.since,
        tokenId: query.tokenId,
        tzOffsetMinutes: query.tzOffsetMinutes,
      }
    )

    try {
      await cache.set(key, JSON.stringify(rows), TRANSFER_STATS_CACHE_TTL_MS)
    } catch (error) {
      logger.error("transfer-stats-cache", "Cache write failed", {
        cacheKey: key,
        error,
      })
    }

    return rows
  }

  return async (args: TransferStatsArgs) => {
    const granularity = normalizeGranularity(args.granularity)
    const points = normalizePoints(args.points)
    const tzOffsetMinutes = normalizeTzOffsetMinutes(args.tzOffsetMinutes)
    const { format, seconds } = granularityConfig[granularity]
    const normalizedNow =
      Math.floor(now() / TRANSFER_STATS_CACHE_TTL_MS) *
      TRANSFER_STATS_CACHE_TTL_MS
    const since = Math.floor(normalizedNow / 1000) - points * seconds
    const key = buildTransferStatsCacheKey({
      format,
      granularity,
      points,
      since,
      timezone: TRANSFER_STATS_TIMEZONE,
      tokenId: args.tokenId ?? null,
      tzOffsetMinutes,
    })

    const existing = inFlight.get(key)
    if (existing) {
      logger.debug("transfer-stats-cache", "Joined in-flight query", {
        cacheKey: key,
      })
      return existing
    }

    const pending = load(key, {
      bucketExpr: buildBucketExpr(granularity, format),
      since,
      tokenId: args.tokenId,
      tzOffsetMinutes,
    })
    inFlight.set(key, pending)

    try {
      return await pending
    } finally {
      if (inFlight.get(key) === pending) {
        inFlight.delete(key)
      }
    }
  }
}
