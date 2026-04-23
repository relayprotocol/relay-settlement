import type { Database } from "../db/connection.js"
import type { TokenRow, BalanceRow } from "../models/db.js"

const normalizeTokenRow = (
  row: Omit<TokenRow, "updated_at"> & { updated_at: string | Date }
): TokenRow => ({
  ...row,
  updated_at:
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at),
})

export const listTokens = async (
  db: Database,
  limit: number,
  cursor?: string
) => {
  const parsedCursor = cursor ? parseTokenCursor(cursor) : null
  const params: Record<string, string | number> = { limit }
  const where = parsedCursor
    ? `WHERE t.transfers < $/cursorTransfers/
        OR (t.transfers = $/cursorTransfers/ AND t.token_id > $/cursorTokenId/)`
    : ""

  if (parsedCursor) {
    params.cursorTransfers = parsedCursor.transfers
    params.cursorTokenId = parsedCursor.tokenId
  }

  const rows = await db.manyOrNone<
    Omit<TokenRow, "updated_at"> & { updated_at: string | Date }
  >(
    `SELECT
       t.token_id,
       t.name,
       t.symbol,
       t.decimals,
       t.total_supply,
       t.holders,
       t.transfers,
       t.updated_at
     FROM tokens t
     ${where}
     ORDER BY t.transfers DESC, t.token_id ASC
     LIMIT $/limit/`,
    params
  )

  const normalizedRows = rows.map(normalizeTokenRow)
  const last = normalizedRows[normalizedRows.length - 1]
  const nextCursor =
    normalizedRows.length === limit && last
      ? `${last.transfers ?? 0}:${last.token_id}`
      : null

  return { nextCursor, rows: normalizedRows }
}

export const searchTokensByName = async (
  db: Database,
  query: string,
  limit: number,
  cursor?: string
) => {
  const params: Record<string, string | number> = {
    limit,
    needle: `%${query}%`,
  }
  let cursorClause = ""

  if (cursor) {
    const [nameCursor, tokenCursor] = cursor.split("::")
    cursorClause =
      "AND (LOWER(t.name) > LOWER($/nameCursor/) OR (LOWER(t.name) = LOWER($/nameCursor/) AND t.token_id > $/tokenCursor/))"
    params.nameCursor = nameCursor ?? ""
    params.tokenCursor = tokenCursor ?? ""
  }

  const rows = await db.manyOrNone<
    Omit<TokenRow, "updated_at"> & { updated_at: string | Date }
  >(
    `SELECT
      t.token_id,
      t.name,
      t.symbol,
      t.decimals,
      t.total_supply,
      t.holders,
      t.transfers,
      t.updated_at
    FROM tokens t
    WHERE t.name ILIKE $/needle/ ${cursorClause}
    ORDER BY LOWER(t.name) ASC, t.token_id ASC
    LIMIT $/limit/`,
    params
  )

  const normalizedRows = rows.map(normalizeTokenRow)
  const last = normalizedRows[normalizedRows.length - 1]
  const nextCursor =
    normalizedRows.length === limit && last
      ? `${last.name ?? ""}::${last.token_id}`
      : null

  return { nextCursor, rows: normalizedRows }
}

export const getToken = async (db: Database, tokenId: string) => {
  const row = await db.oneOrNone<
    Omit<TokenRow, "updated_at"> & { updated_at: string | Date }
  >(
    `SELECT
      t.token_id,
      t.name,
      t.symbol,
      t.decimals,
      t.total_supply,
      t.holders,
      t.transfers,
      t.updated_at
    FROM tokens t
    WHERE t.token_id = $1`,
    [tokenId]
  )

  return row ? normalizeTokenRow(row) : null
}

export const listTokenBalances = async (
  db: Database,
  tokenId: string,
  limit: number,
  cursor?: string
) => {
  const parsedCursor = cursor ? parseBalanceCursor(cursor) : null
  const params: Record<string, string | number> = { limit, tokenId }
  const where = parsedCursor
    ? `AND (
         balance < ($/cursorBalance/)::numeric
         OR (balance = ($/cursorBalance/)::numeric AND address > $/cursorAddress/)
       )`
    : ""

  if (parsedCursor) {
    params.cursorBalance = parsedCursor.balance
    params.cursorAddress = parsedCursor.address
  }

  const rows = await db.manyOrNone<BalanceRow>(
    `SELECT address, token_id, balance
     FROM balances
     WHERE token_id = $/tokenId/
     ${where}
     ORDER BY balance DESC, address ASC
     LIMIT $/limit/`,
    params
  )

  const last = rows[rows.length - 1]
  const nextCursor =
    rows.length === limit && last ? `${last.balance}:${last.address}` : null

  return { nextCursor, rows }
}

const parseTokenCursor = (cursor: string) => {
  const [transfersStr, tokenId] = cursor.split(":")
  const transfers = Number(transfersStr)
  if (!tokenId || !Number.isFinite(transfers)) return null
  return { tokenId, transfers }
}

const parseBalanceCursor = (cursor: string) => {
  const [balance, address] = cursor.split(":")
  if (!address || !balance || !/^-?\d+$/.test(balance)) return null
  return { address, balance }
}
