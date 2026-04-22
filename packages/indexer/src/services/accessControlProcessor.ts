import { Contract } from "ethers"
import { RelayHub } from "@relay-protocol/settlement-abis"
import { Interface } from "ethers"
import type { Queryable } from "../db/connection.js"

const accessControlInterface = new Interface(RelayHub)

export type AccessControlEvent = {
  eventType: "RoleGranted" | "RoleRevoked" | "RoleAdminChanged"
  role: string
  account?: string
  sender?: string
  previousAdminRole?: string
  newAdminRole?: string
}

export const parseAccessControlLog = (log: {
  topics: readonly string[]
  data: string
}): AccessControlEvent | null => {
  try {
    const parsed = accessControlInterface.parseLog(log)
    if (!parsed) return null
    if (parsed.name === "RoleGranted") {
      return {
        account: parsed.args.account,
        eventType: "RoleGranted",
        role: parsed.args.role,
        sender: parsed.args.sender,
      }
    }
    if (parsed.name === "RoleRevoked") {
      return {
        account: parsed.args.account,
        eventType: "RoleRevoked",
        role: parsed.args.role,
        sender: parsed.args.sender,
      }
    }
    if (parsed.name === "RoleAdminChanged") {
      return {
        eventType: "RoleAdminChanged",
        newAdminRole: parsed.args.newAdminRole,
        previousAdminRole: parsed.args.previousAdminRole,
        role: parsed.args.role,
      }
    }
    return null
  } catch {
    return null
  }
}

export const insertRoleEvent = async (
  db: Queryable,
  log: {
    contractAddress: string
    blockNumber: number
    transactionHash: string
    index: number
    timestamp: number
  },
  event: AccessControlEvent
) => {
  const now = new Date().toISOString()
  return db.result(
    `INSERT INTO role_events(
      contract_address, block_number, tx_hash, log_index, event_type, role, account, sender, previous_admin_role, new_admin_role, timestamp, created_at, updated_at
    ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT(contract_address, tx_hash, log_index) DO NOTHING
     RETURNING 1`,
    [
      log.contractAddress.toLowerCase(),
      log.blockNumber,
      log.transactionHash,
      log.index,
      event.eventType,
      event.role,
      event.account?.toLowerCase() ?? null,
      event.sender?.toLowerCase() ?? null,
      event.previousAdminRole ?? null,
      event.newAdminRole ?? null,
      log.timestamp,
      now,
      now,
    ],
    (result) => result.rowCount
  )
}

const upsertRoleMember = async (
  db: Queryable,
  contractAddress: string,
  role: string,
  account: string
) => {
  const now = new Date().toISOString()
  await db.none(
    `INSERT INTO role_members(contract_address, role, account, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5)
     ON CONFLICT(contract_address, role, account) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
    [contractAddress.toLowerCase(), role, account.toLowerCase(), now, now]
  )
}

const deleteRoleMember = async (
  db: Queryable,
  contractAddress: string,
  role: string,
  account: string
) => {
  await db.none(
    "DELETE FROM role_members WHERE contract_address = $1 AND role = $2 AND account = $3",
    [contractAddress.toLowerCase(), role, account.toLowerCase()]
  )
}

const upsertRoleAdmin = async (
  db: Queryable,
  contractAddress: string,
  role: string,
  adminRole: string
) => {
  const now = new Date().toISOString()
  await db.none(
    `INSERT INTO role_admins(contract_address, role, admin_role, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5)
     ON CONFLICT(contract_address, role) DO UPDATE SET admin_role = EXCLUDED.admin_role, updated_at = EXCLUDED.updated_at`,
    [contractAddress.toLowerCase(), role, adminRole, now, now]
  )
}

export const applyRoleEvent = async (
  db: Queryable,
  contractAddress: string,
  event: AccessControlEvent
) => {
  if (event.eventType === "RoleGranted") {
    if (!event.account) return
    await upsertRoleMember(db, contractAddress, event.role, event.account)
    return
  }

  if (event.eventType === "RoleRevoked") {
    if (!event.account) return
    await deleteRoleMember(db, contractAddress, event.role, event.account)
    return
  }

  if (event.eventType === "RoleAdminChanged") {
    if (!event.newAdminRole) return
    await upsertRoleAdmin(db, contractAddress, event.role, event.newAdminRole)
  }
}

export const reconcileRoleStateFromChain = async (
  db: Queryable,
  contract: Contract,
  contractAddress: string,
  event: AccessControlEvent
) => {
  if (event.eventType === "RoleAdminChanged") {
    const adminRole = String(await contract.getRoleAdmin(event.role))
    await upsertRoleAdmin(db, contractAddress, event.role, adminRole)
    return
  }

  if (!event.account) return

  const hasRole = Boolean(await contract.hasRole(event.role, event.account))
  if (hasRole) {
    await upsertRoleMember(db, contractAddress, event.role, event.account)
    return
  }

  await deleteRoleMember(db, contractAddress, event.role, event.account)
}
