import type { Queryable } from "./connection.js"

/**
 * Meta is the indexer's small key-value state table.
 * It stores operational checkpoints and other runtime markers such as the
 * last processed block for each indexing lane.
 */
export const getMeta = async (db: Queryable, key: string) => {
  const row = await db.oneOrNone<{ value: string }>(
    "SELECT value FROM meta WHERE key = $1",
    [key]
  )

  return row?.value ?? null
}

/**
 * Persist a meta value for a runtime marker such as an indexing checkpoint.
 */
export const setMeta = async (db: Queryable, key: string, value: string) => {
  const now = new Date().toISOString()

  await db.none(
    `INSERT INTO meta(key, value, created_at, updated_at)
     VALUES($1, $2, $3, $4)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, value, now, now]
  )
}
