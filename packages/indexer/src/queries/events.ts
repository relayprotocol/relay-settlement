import type { Database } from "../db/connection.js"
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

const buildBucketExpr = (granularity: string) => {
  const shiftedTs =
    "(to_timestamp(timestamp) AT TIME ZONE 'UTC' + make_interval(mins => $/tzOffsetMinutes/))"
  switch (granularity) {
    case "minute":
      return `to_char(date_trunc('minute', ${shiftedTs}), 'YYYY-MM-DD HH24:MI')`
    case "hour":
      return `to_char(date_trunc('hour', ${shiftedTs}), 'YYYY-MM-DD HH24:00')`
    case "week":
      return `to_char(date_trunc('week', ${shiftedTs}), 'YYYY-MM-DD')`
    case "month":
      return `to_char(date_trunc('month', ${shiftedTs}), 'YYYY-MM')`
    case "day":
    default:
      return `to_char(date_trunc('day', ${shiftedTs}), 'YYYY-MM-DD')`
  }
}

const secondsForGranularity = (granularity: string) => {
  switch (granularity) {
    case "minute":
      return 60
    case "hour":
      return 3600
    case "week":
      return 604800
    case "month":
      return 2592000
    case "day":
    default:
      return 86400
  }
}

export const transferStats = async (
  db: Database,
  args: {
    tokenId?: string
    granularity: string
    points: number
    tzOffsetMinutes: number
  }
) => {
  const { tokenId, granularity, points, tzOffsetMinutes } = args
  const since =
    Math.floor(Date.now() / 1000) - points * secondsForGranularity(granularity)
  const bucketExpr = buildBucketExpr(granularity)

  return db.manyOrNone<TransferStatRow>(
    `SELECT ${bucketExpr} AS bucket, COUNT(*)::int AS count
     FROM events
     WHERE ${tokenId ? "token_id = $/tokenId/ AND " : ""}timestamp >= $/since/
     GROUP BY bucket
     ORDER BY bucket ASC`,
    { since, tokenId, tzOffsetMinutes }
  )
}
