import type { Queryable } from "../db/connection.js"
import type { IndexedLog } from "./logPages.js"

export const getEventKey = (
  log: Pick<IndexedLog, "transactionHash" | "index">
) => `${log.transactionHash.toLowerCase()}:${log.index}`

// Call with one bounded log page, not a block range (one block can be very dense).
// The case-insensitive fallback uses the block/log index, avoiding a table-wide
// LOWER(tx_hash) scan when an RPC changes the hex casing of an existing event.
export const getIndexedEventKeys = async (
  db: Queryable,
  logs: readonly Pick<IndexedLog, "transactionHash" | "index" | "blockNumber">[]
) => {
  if (!logs.length) return new Set<string>()
  const rows = await db.manyOrNone<{ log_index: number; tx_hash: string }>(
    `WITH requested AS (
       SELECT * FROM unnest($1::text[], $2::integer[], $3::bigint[])
         AS logs(tx_hash, log_index, block_number)
     )
     SELECT events.tx_hash, events.log_index
     FROM events
     JOIN requested ON events.tx_hash = requested.tx_hash AND events.log_index = requested.log_index
     UNION
     SELECT events.tx_hash, events.log_index
     FROM events
     JOIN requested ON events.block_number = requested.block_number AND events.log_index = requested.log_index
     WHERE LOWER(events.tx_hash) = LOWER(requested.tx_hash)`,
    [
      logs.map((log) => log.transactionHash),
      logs.map((log) => log.index),
      logs.map((log) => log.blockNumber),
    ]
  )
  return new Set(
    rows.map((row) => `${row.tx_hash.toLowerCase()}:${row.log_index}`)
  )
}
