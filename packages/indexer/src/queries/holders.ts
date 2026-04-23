import type { Database } from "../db/connection.js"

export const listHolders = async (
  db: Database,
  limit: number,
  cursor?: string
) => {
  const params: Record<string, string | number> = { limit }
  let cursorClause = ""
  if (cursor) {
    cursorClause = "WHERE address > $/cursor/"
    params.cursor = cursor.toLowerCase()
  }

  const rows = await db.manyOrNone<{
    address: string
    last_transfer_timestamp: number | null
  }>(
    `SELECT address, MAX(last_transfer_at) AS last_transfer_timestamp
     FROM balances
     ${cursorClause}
     GROUP BY address
     ORDER BY address ASC
     LIMIT $/limit/`,
    params
  )

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? last.address : null
  return { nextCursor, rows }
}
