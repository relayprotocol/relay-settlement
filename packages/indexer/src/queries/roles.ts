import type { Database } from "../db/connection.js"
import type { RoleAdminRow, RoleEventRow, RoleMemberRow } from "../models/db.js"

export const listRoleEvents = async (
  db: Database,
  options: {
    contractAddress: string
    limit: number
    cursor?: string
    role?: string
    account?: string
  }
) => {
  const params: Record<string, string | number> = {
    contractAddress: options.contractAddress.toLowerCase(),
    limit: options.limit,
  }
  const where: string[] = ["contract_address = $/contractAddress/"]

  if (options.role) {
    where.push("role = $/role/")
    params.role = options.role
  }
  if (options.account) {
    where.push("account = $/account/")
    params.account = options.account.toLowerCase()
  }

  if (options.cursor) {
    const [blockRaw, logRaw] = options.cursor.split(":")
    const block = Number(blockRaw)
    const logIndex = Number(logRaw)
    if (Number.isFinite(block) && Number.isFinite(logIndex)) {
      where.push(
        "(block_number < $/cursorBlock/ OR (block_number = $/cursorBlock/ AND log_index < $/cursorLogIndex/))"
      )
      params.cursorBlock = block
      params.cursorLogIndex = logIndex
    }
  }

  const rows = await db.manyOrNone<RoleEventRow>(
    `SELECT contract_address, block_number, tx_hash, log_index, event_type, role, account, sender,
            previous_admin_role, new_admin_role, timestamp
     FROM role_events
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY block_number DESC, log_index DESC
     LIMIT $/limit/`,
    params
  )

  const last = rows[rows.length - 1]
  const nextCursor =
    rows.length === options.limit && last
      ? `${last.block_number}:${last.log_index}`
      : null

  return { nextCursor, rows }
}

export const listRoleMembers = async (
  db: Database,
  contractAddress: string,
  role: string,
  limit: number,
  cursor?: string
) => {
  const params: Record<string, string | number> = {
    contractAddress: contractAddress.toLowerCase(),
    limit,
    role,
  }
  const cursorClause = cursor ? "AND account > $/cursor/" : ""
  if (cursor) {
    params.cursor = cursor
  }

  const rows = await db.manyOrNone<RoleMemberRow>(
    `SELECT contract_address, role, account
     FROM role_members
     WHERE contract_address = $/contractAddress/ AND role = $/role/ ${cursorClause}
     ORDER BY account ASC
     LIMIT $/limit/`,
    params
  )

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? last.account : null
  return { nextCursor, rows }
}

export const listRolesForAccount = async (
  db: Database,
  contractAddress: string,
  account: string,
  limit: number,
  cursor?: string
) => {
  const params: Record<string, string | number> = {
    account: account.toLowerCase(),
    contractAddress: contractAddress.toLowerCase(),
    limit,
  }
  const cursorClause = cursor ? "AND role > $/cursor/" : ""
  if (cursor) {
    params.cursor = cursor
  }

  const rows = await db.manyOrNone<RoleMemberRow>(
    `SELECT contract_address, role, account
     FROM role_members
     WHERE contract_address = $/contractAddress/ AND account = $/account/ ${cursorClause}
     ORDER BY role ASC
     LIMIT $/limit/`,
    params
  )

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? last.role : null
  return { nextCursor, rows }
}

export const listRoleMembersForContract = async (
  db: Database,
  contractAddress: string
) =>
  db.manyOrNone<RoleMemberRow>(
    `SELECT contract_address, role, account
     FROM role_members
     WHERE contract_address = $1
     ORDER BY role ASC, account ASC`,
    [contractAddress.toLowerCase()]
  )

export const getRoleAdmin = async (
  db: Database,
  contractAddress: string,
  role: string
) =>
  db.oneOrNone<RoleAdminRow>(
    "SELECT contract_address, role, admin_role FROM role_admins WHERE contract_address = $1 AND role = $2",
    [contractAddress.toLowerCase(), role]
  )
