import type { Database } from "../db/connection.js"

export const listBalancesForAddress = async (
  db: Database,
  address: string,
  limit: number,
  cursor?: string
) => {
  const params: Record<string, string | number> = {
    address: address.toLowerCase(),
    limit,
  }
  const cursorClause = cursor ? "AND token_id > $/cursor/" : ""
  if (cursor) {
    params.cursor = cursor
  }

  const rows = await db.manyOrNone<{ token_id: string; balance: string }>(
    `SELECT token_id, balance
     FROM balances
     WHERE address = $/address/
     ${cursorClause}
     ORDER BY token_id ASC
     LIMIT $/limit/`,
    params
  )
  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? last.token_id : null
  return { nextCursor, rows }
}
