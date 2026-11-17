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
const TRANSFER_STATS_MAX_AGE_MS = 30 * 60 * 1000
const TRANSFER_STATS_RETRY_MS = 30 * 1000
const MAX_REFRESHES = 2
const MAX_WAITING_REFRESHES = 8
const REFRESH_WAIT_MS = 2000
const MAX_FAILURES = 1000

type TransferStatsGranularity = "day" | "hour" | "minute" | "month" | "week"
type TransferStatsArgs = {
  tokenId?: string
  granularity: string
  points: number
  tzOffsetMinutes: number
}
export type TransferStatsResult = {
  rows: TransferStatRow[]
  updatedAt: string
  stale: boolean
}
type CachedStats = { rows: TransferStatRow[]; fetchedAt: number; since: number }
type TransferStatsCacheLogger = Pick<
  typeof jsonLogger,
  "debug" | "error" | "info"
>

export class TransferStatsUnavailableError extends Error {}

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
const normalizeTzOffsetMinutes = (offset: number) =>
  Number.isFinite(offset)
    ? Math.max(-720, Math.min(840, Math.trunc(offset)))
    : 0

const parseCachedStats = (value: string): CachedStats => {
  const entry = JSON.parse(value) as CachedStats | null
  if (
    !entry ||
    !Number.isFinite(entry.fetchedAt) ||
    !Number.isFinite(entry.since) ||
    !Array.isArray(entry.rows) ||
    !entry.rows.every(
      (row) =>
        row && typeof row.bucket === "string" && Number.isInteger(row.count)
    )
  )
    throw new Error("Invalid transfer stats cache value")
  return entry
}

// Both readiness and data are read in one statement snapshot. Until the explicit
// backfill finishes, use the cheaper raw query. Format only the final buckets.
export const queryTransferStats = async (
  db: Database,
  query: {
    granularity: TransferStatsGranularity
    since: number
    tokenId?: string
    tzOffsetMinutes: number
  }
) => {
  const { format } = granularityConfig[query.granularity]
  const tokenFilter = query.tokenId ? "token_id = $/tokenId/ AND " : ""
  return db.manyOrNone<TransferStatRow>(
    `WITH ready AS MATERIALIZED (
       SELECT 1 FROM transfer_stats_backfill WHERE id = 1 AND completed_at IS NOT NULL
     ), source AS (
       SELECT timestamp, 1::bigint AS transfers FROM events
       WHERE ${tokenFilter}timestamp >= $/since/ AND NOT EXISTS(SELECT 1 FROM ready)
       UNION ALL
       SELECT minute_start AS timestamp, transfers FROM transfer_stats_minutes
       WHERE ${tokenFilter}minute_start >= $/completeMinute/ AND EXISTS(SELECT 1 FROM ready)
       UNION ALL
       SELECT timestamp, 1::bigint AS transfers FROM events
       WHERE ${tokenFilter}timestamp >= $/since/ AND timestamp < $/completeMinute/
         AND EXISTS(SELECT 1 FROM ready)
     ), counts AS (
       SELECT date_trunc('${query.granularity}',
         to_timestamp(timestamp) AT TIME ZONE 'UTC' + make_interval(mins => $/tzOffsetMinutes/)
       ) AS bucket, SUM(transfers)::int AS count
       FROM source GROUP BY bucket
     ) SELECT to_char(bucket, '${format}') AS bucket, count FROM counts ORDER BY bucket`,
    { ...query, completeMinute: Math.ceil(query.since / 60) * 60 }
  )
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
  const inFlight = new Map<string, Promise<TransferStatsResult>>()
  const retryAfter = new Map<string, number>()
  const waitingRefreshes = new Set<(_acquired: boolean) => void>()
  let activeRefreshes = 0

  const acquireRefresh = async () => {
    if (activeRefreshes < MAX_REFRESHES) {
      activeRefreshes++
      return true
    }
    if (waitingRefreshes.size >= MAX_WAITING_REFRESHES) return false
    return new Promise<boolean>((resolve) => {
      const finish = (acquired: boolean) => {
        clearTimeout(timer)
        waitingRefreshes.delete(finish)
        resolve(acquired)
      }
      const timer = setTimeout(() => finish(false), REFRESH_WAIT_MS)
      waitingRefreshes.add(finish)
    })
  }
  const releaseRefresh = () => {
    const next = waitingRefreshes.values().next().value
    // Transfer the occupied slot directly so new arrivals cannot jump the queue.
    if (next) next(true)
    else activeRefreshes--
  }

  const load = async (
    key: string,
    query: Parameters<typeof queryTransferStats>[1]
  ): Promise<TransferStatsResult> => {
    let cached: CachedStats | undefined
    try {
      const value = await cache.get(key)
      if (value !== null) {
        const entry = parseCachedStats(value)
        const age = now() - entry.fetchedAt
        if (age >= 0 && age < TRANSFER_STATS_MAX_AGE_MS) cached = entry
      }
    } catch (error) {
      logger.error("transfer-stats-cache", "Cache read failed", { error })
    }
    const result = (
      entry: CachedStats,
      stale: boolean
    ): TransferStatsResult => ({
      rows: entry.rows,
      stale,
      updatedAt: new Date(entry.fetchedAt).toISOString(),
    })
    if (
      cached &&
      cached.since === query.since &&
      now() - cached.fetchedAt < TRANSFER_STATS_CACHE_TTL_MS
    ) {
      logger.debug("transfer-stats-cache", "Cache hit", { cacheKey: key })
      return result(cached, false)
    }
    const staleOrThrow = () => {
      if (cached && now() - cached.fetchedAt < TRANSFER_STATS_MAX_AGE_MS) {
        logger.info("transfer-stats-cache", "Serving stale statistics", {
          cacheKey: key,
          updatedAt: cached.fetchedAt,
        })
        return result(cached, true)
      }
      throw new TransferStatsUnavailableError(
        "Transfer statistics temporarily unavailable; retry shortly"
      )
    }
    for (const [failedKey, until] of retryAfter) {
      if (until <= now()) retryAfter.delete(failedKey)
    }
    if (retryAfter.has(key) || (cached && activeRefreshes >= MAX_REFRESHES))
      return staleOrThrow()
    if (!(await acquireRefresh())) return staleOrThrow()

    const startedAt = now()
    logger.debug("transfer-stats-cache", "Cache miss", { cacheKey: key })
    try {
      const rows = await queryTransferStats(db, query)
      const entry = { fetchedAt: startedAt, rows, since: query.since }
      logger.info("transfer-stats-query", "Statistics refreshed", {
        durationMs: now() - startedAt,
        granularity: query.granularity,
        since: query.since,
        tokenId: query.tokenId ?? null,
      })
      try {
        await cache.set(key, JSON.stringify(entry), TRANSFER_STATS_MAX_AGE_MS)
      } catch (error) {
        logger.error("transfer-stats-cache", "Cache write failed", { error })
      }
      return result(entry, false)
    } catch (error) {
      if (retryAfter.size >= MAX_FAILURES)
        retryAfter.delete(retryAfter.keys().next().value!)
      retryAfter.set(key, now() + TRANSFER_STATS_RETRY_MS)
      logger.error("transfer-stats-query", "Statistics refresh failed", {
        durationMs: now() - startedAt,
        error,
        granularity: query.granularity,
        since: query.since,
        tokenId: query.tokenId ?? null,
      })
      return staleOrThrow()
    } finally {
      releaseRefresh()
    }
  }

  return (args: TransferStatsArgs): Promise<TransferStatsResult> => {
    const granularity = normalizeGranularity(args.granularity)
    const points = normalizePoints(args.points)
    const tzOffsetMinutes = normalizeTzOffsetMinutes(args.tzOffsetMinutes)
    const normalizedNow =
      Math.floor(now() / TRANSFER_STATS_CACHE_TTL_MS) *
      TRANSFER_STATS_CACHE_TTL_MS
    const since =
      Math.floor(normalizedNow / 1000) -
      points * granularityConfig[granularity].seconds
    // Stable identity retains the last successful chart across window boundaries.
    const key = `indexer:transfer-stats:v2:${createHash("sha256")
      .update(
        JSON.stringify({
          granularity,
          points,
          tokenId: args.tokenId ?? null,
          tzOffsetMinutes,
        })
      )
      .digest("hex")}`
    const existing = inFlight.get(key)
    if (existing) {
      logger.debug("transfer-stats-cache", "Joined in-flight query", {
        cacheKey: key,
      })
      return existing
    }
    const pending = load(key, {
      granularity,
      since,
      tokenId: args.tokenId,
      tzOffsetMinutes,
    }).finally(() => {
      inFlight.delete(key)
    })
    inFlight.set(key, pending)
    return pending
  }
}
