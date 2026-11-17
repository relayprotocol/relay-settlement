import type { ITask } from "pg-promise"
import type { Database, Queryable } from "../db/connection.js"

type MinuteKey = { token_id: string; minute_start: number }
type BackfillState = {
  next_timestamp: number
  end_timestamp: number
  after_minute: number | null
  after_token_id: string | null
  completed_at: Date | null
}

// Keep one connection for the entire command, including pauses between batches.
// A reset must not race with a running job that could enable summary reads again.
export const withTransferStatsBackfillLock = <T>(
  db: Database,
  run: (_db: ITask<unknown>) => Promise<T>
) =>
  db.task(async (task) => {
    const key = "hashtextextended('transfer-stats-backfill', 0)"
    const { acquired } = await task.one<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${key}) AS acquired`
    )
    if (!acquired)
      throw new Error("Another transfer statistics backfill is running")
    try {
      return await run(task)
    } finally {
      await task.one(`SELECT pg_advisory_unlock(${key})`)
    }
  })

// Lock summary rows before recounting with a fresh READ COMMITTED snapshot.
// A writer waiting on these rows will increment after this transaction commits.
export const repairTransferStatsMinutes = async (
  tx: ITask<unknown>,
  keys: MinuteKey[]
) => {
  if (!keys.length) return
  const params = [JSON.stringify(keys)]
  const requested = `SELECT token_id, minute_start FROM jsonb_to_recordset($1::jsonb)
    AS r(token_id text, minute_start bigint)`
  await tx.none(
    `INSERT INTO transfer_stats_minutes(token_id, minute_start, transfers)
     SELECT token_id, minute_start, 0 FROM (${requested}) r
     ORDER BY token_id, minute_start
     ON CONFLICT DO NOTHING`,
    params
  )
  await tx.any(
    `SELECT s.token_id FROM transfer_stats_minutes s
     JOIN (${requested}) r USING (token_id, minute_start)
     ORDER BY s.token_id, s.minute_start FOR UPDATE OF s`,
    params
  )
  await tx.none(
    `UPDATE transfer_stats_minutes s SET transfers = counts.transfers
     FROM (
       SELECT r.token_id, r.minute_start, (
         SELECT COUNT(*) FROM events e WHERE e.token_id = r.token_id
         AND e.timestamp >= r.minute_start AND e.timestamp < r.minute_start + 60
       ) AS transfers FROM (${requested}) r
     ) counts
     WHERE s.token_id = counts.token_id AND s.minute_start = counts.minute_start`,
    params
  )
  await tx.none(
    `DELETE FROM transfer_stats_minutes s USING (${requested}) r
     WHERE s.token_id = r.token_id AND s.minute_start = r.minute_start
       AND s.transfers = 0`,
    params
  )
}

// Deleting readiness makes readers use raw events until a full backfill succeeds.
// Run before reverting to any version that does not maintain minute counts.
export const resetTransferStatsBackfill = async (db: Queryable) => {
  await db.none("DELETE FROM transfer_stats_backfill WHERE id = 1")
}

export const backfillTransferStatsBatch = async (
  db: Queryable,
  batchSize = 100
) => {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error(
      "Transfer stats backfill batch size must be between 1 and 1000"
    )
  }
  return db.tx(async (tx) => {
    await tx.none("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
    await tx.none("SET LOCAL lock_timeout = '2s'")
    await tx.none("SET LOCAL statement_timeout = '8s'")
    await tx.none(
      `INSERT INTO transfer_stats_backfill(id, next_timestamp, end_timestamp)
       SELECT 1, COALESCE(MIN(first_minute), 0), COALESCE(MAX(last_minute) + 60, 0)
       FROM (
         SELECT FLOOR(MIN(timestamp)::numeric / 60)::bigint * 60 AS first_minute,
                FLOOR(MAX(timestamp)::numeric / 60)::bigint * 60 AS last_minute FROM events
         UNION ALL
         SELECT MIN(minute_start), MAX(minute_start) FROM transfer_stats_minutes
       ) bounds
       ON CONFLICT DO NOTHING`
    )
    const state = await tx.one<BackfillState>(
      "SELECT * FROM transfer_stats_backfill WHERE id = 1 FOR UPDATE"
    )
    if (state.completed_at) return { complete: true, repaired: 0 }
    const start = Number(state.next_timestamp)
    const end = Math.min(start + 600, Number(state.end_timestamp))
    const keys = await tx.any<MinuteKey>(
      `WITH keys AS (
         SELECT token_id, FLOOR(timestamp::numeric / 60)::bigint * 60 AS minute_start
         FROM events WHERE timestamp >= $/start/ AND timestamp < $/end/
         UNION
         SELECT token_id, minute_start FROM transfer_stats_minutes
         WHERE minute_start >= $/start/ AND minute_start < $/end/
       ) SELECT token_id, minute_start FROM keys
       WHERE ($/afterMinute/::bigint IS NULL OR
         (minute_start, token_id) >
         ($/afterMinute/::bigint, $/afterToken/::text))
       ORDER BY minute_start, token_id LIMIT $/batchSize/`,
      {
        afterMinute: state.after_minute,
        afterToken: state.after_token_id,
        batchSize,
        end,
        start,
      }
    )
    await repairTransferStatsMinutes(tx, keys)
    const exhausted = keys.length < batchSize
    const last = keys[keys.length - 1]
    const complete = exhausted && end >= Number(state.end_timestamp)
    await tx.none(
      `UPDATE transfer_stats_backfill SET next_timestamp = $/next/,
       after_minute = $/minute/, after_token_id = $/token/,
       completed_at = CASE WHEN $/complete/ THEN NOW() ELSE NULL END,
       updated_at = NOW() WHERE id = 1`,
      {
        complete,
        minute: exhausted ? null : last!.minute_start,
        next: exhausted ? end : start,
        token: exhausted ? null : last!.token_id,
      }
    )
    return {
      complete,
      nextTimestamp: exhausted ? end : start,
      repaired: keys.length,
    }
  })
}
