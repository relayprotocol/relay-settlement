import { Provider } from "ethers"
import { Database } from "../db/connection.js"
import { getMeta } from "../db/meta.js"
import { config } from "../config.js"
import {
  HUB_ROLE_META_KEY,
  HUB_TRANSFER_META_KEY,
  LEGACY_HUB_ROLE_META_KEY,
  LEGACY_HUB_TRANSFER_META_KEY,
  ORACLE_EXECUTION_META_KEY,
  ORACLE_ROLE_META_KEY,
} from "../indexerState.js"

type SyncStatus = {
  lastProcessedBlock: number | null
  lag: number
}

type FailedEventStatus = {
  count: number
  oldestBlockNumber: number | null
}

export type HealthResponse = {
  ok: boolean
  latestChainBlock: number
  maxAllowedLag: number
  failedEvents: FailedEventStatus
  hub: SyncStatus & {
    transferLastProcessedBlock: number | null
    roleLastProcessedBlock: number | null
  }
  oracle: SyncStatus & {
    roleLastProcessedBlock: number | null
    executionLastProcessedBlock: number | null
  }
}

export type HealthCheckpointState = {
  latestChainBlock: number
  maxAllowedLag: number
  hubTransferLastProcessedBlock: number | null
  hubRoleLastProcessedBlock: number | null
  oracleRoleLastProcessedBlock: number | null
  oracleExecutionLastProcessedBlock: number | null
  failedEvents?: FailedEventStatus
}

const parseBlock = (value: string | null) => {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const minIfAllPresent = (values: Array<number | null>) =>
  values.every((value) => value != null)
    ? Math.min(...(values as number[]))
    : null

const toLag = (latestChainBlock: number, lastProcessedBlock: number | null) => {
  if (lastProcessedBlock == null) {
    return latestChainBlock
  }

  return Math.max(latestChainBlock - lastProcessedBlock, 0)
}

const getMetaWithFallback = async (
  db: Database,
  key: string,
  fallbackKey?: string
) => {
  const value = await getMeta(db, key)
  if (value != null) {
    return value
  }

  if (!fallbackKey) {
    return null
  }

  return getMeta(db, fallbackKey)
}

export const getHealthStatus = async (
  db: Database,
  provider: Provider
): Promise<HealthResponse> => {
  const latestChainBlock = await provider.getBlockNumber()
  const [
    hubTransferRaw,
    hubRoleRaw,
    oracleRoleRaw,
    oracleExecutionRaw,
    failedEvents,
  ] = await Promise.all([
    getMetaWithFallback(
      db,
      HUB_TRANSFER_META_KEY,
      LEGACY_HUB_TRANSFER_META_KEY
    ),
    getMetaWithFallback(db, HUB_ROLE_META_KEY, LEGACY_HUB_ROLE_META_KEY),
    getMeta(db, ORACLE_ROLE_META_KEY),
    getMeta(db, ORACLE_EXECUTION_META_KEY),
    getFailedEventStatus(db),
  ])

  return buildHealthResponse({
    failedEvents,
    hubRoleLastProcessedBlock: parseBlock(hubRoleRaw),
    hubTransferLastProcessedBlock: parseBlock(hubTransferRaw),
    latestChainBlock,
    maxAllowedLag: config.healthMaxLagBlocks,
    oracleExecutionLastProcessedBlock: parseBlock(oracleExecutionRaw),
    oracleRoleLastProcessedBlock: parseBlock(oracleRoleRaw),
  })
}

const getFailedEventStatus = async (
  db: Database
): Promise<FailedEventStatus> => {
  const row = await db.one<{
    count: number | string
    oldest_block_number: number | string | null
  }>(
    `SELECT COUNT(*)::int AS count, MIN(block_number)::bigint AS oldest_block_number
     FROM failed_events`
  )

  return {
    count: Number(row.count),
    oldestBlockNumber:
      row.oldest_block_number == null ? null : Number(row.oldest_block_number),
  }
}

export const buildHealthResponse = ({
  failedEvents = { count: 0, oldestBlockNumber: null },
  latestChainBlock,
  maxAllowedLag,
  hubTransferLastProcessedBlock,
  hubRoleLastProcessedBlock,
  oracleRoleLastProcessedBlock,
  oracleExecutionLastProcessedBlock,
}: HealthCheckpointState): HealthResponse => {
  const hubLastProcessedBlock = minIfAllPresent([
    hubTransferLastProcessedBlock,
    hubRoleLastProcessedBlock,
  ])
  const oracleLastProcessedBlock = minIfAllPresent([
    oracleRoleLastProcessedBlock,
    oracleExecutionLastProcessedBlock,
  ])

  const hubLag = toLag(latestChainBlock, hubLastProcessedBlock)
  const oracleLag = toLag(latestChainBlock, oracleLastProcessedBlock)

  return {
    failedEvents,
    hub: {
      lag: hubLag,
      lastProcessedBlock: hubLastProcessedBlock,
      roleLastProcessedBlock: hubRoleLastProcessedBlock,
      transferLastProcessedBlock: hubTransferLastProcessedBlock,
    },
    latestChainBlock,
    maxAllowedLag,
    ok: hubLag <= maxAllowedLag && oracleLag <= maxAllowedLag,
    oracle: {
      executionLastProcessedBlock: oracleExecutionLastProcessedBlock,
      lag: oracleLag,
      lastProcessedBlock: oracleLastProcessedBlock,
      roleLastProcessedBlock: oracleRoleLastProcessedBlock,
    },
  }
}
