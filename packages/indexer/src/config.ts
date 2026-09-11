import dotenv from "dotenv"
import { relay } from "@relay-protocol/settlement-networks"

dotenv.config()

export type RuntimeConfig = {
  apiRequested: boolean
  allowUnauthenticatedApi: boolean
  authApiKey: string | undefined
  batchSize: number
  confirmationBlocks: number
  databaseUrl: string | undefined
  depositoryBalanceAuditIntervalMs: number
  doBackgroundWork: boolean
  enableApi: boolean
  healthMaxLagBlocks: number
  hubContractAddress: string
  hubStartBlock: number
  indexerAuditConsecutiveFailures: number
  indexerAuditFailureThreshold: number
  indexerAuditIntervalMs: number
  indexerAuditMaxAgeMs: number
  maxTransferReplayBlockRange: number
  oracleApiKey: string | undefined
  oracleApiUrl: string | undefined
  oracleContractAddress: string
  oracleStartBlock: number
  port: number
  priceOracleContractAddress: string
  pollIntervalMs: number
  rpcHttpUrl: string | undefined
  rpcWsUrl: string | undefined
  startBlock: number
  transferCoverageAuditLookbackBlocks: number
  transferOverlapBlocks: number
}

const relayProdContracts = relay.contracts?.prod

if (
  relayProdContracts?.hub == null ||
  relayProdContracts.oracle == null ||
  relayProdContracts.priceOracle == null ||
  relay.earliestBlock == null
) {
  throw new Error(
    "Relay network metadata is missing required deployment fields"
  )
}

export const relayNetworkDefaults = {
  hubContractAddress: relayProdContracts.hub.toLowerCase(),
  oracleContractAddress: relayProdContracts.oracle.toLowerCase(),
  priceOracleContractAddress: relayProdContracts.priceOracle.toLowerCase(),
  startBlock: relay.earliestBlock,
}

export const resolvePort = (value: string | undefined) => {
  if (!value) {
    return 3001
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 3001
}

export const resolveBoolean = (
  value: string | undefined,
  fallback: boolean
) => {
  if (!value) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()

  if (normalized === "1" || normalized === "true") {
    return true
  }

  if (normalized === "0" || normalized === "false") {
    return false
  }

  throw new Error(`Invalid boolean env value: ${value}`)
}

export const resolveAddress = (value: string | undefined, fallback: string) =>
  value ? value.toLowerCase() : fallback

export const resolveEnableApi = (
  requested: boolean,
  authApiKey: string | undefined,
  allowUnauthenticatedApi: boolean
) => requested && (Boolean(authApiKey) || allowUnauthenticatedApi)

export const resolveNumber = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const resolveNonNegativeInteger = (
  value: string | undefined,
  fallback: number
) => {
  const resolved = resolveNumber(value, fallback)
  if (!Number.isFinite(resolved)) {
    return fallback
  }
  return Math.max(0, Math.trunc(resolved))
}

export const validateRuntimeConfig = (config: RuntimeConfig) => {
  if ((config.doBackgroundWork || config.enableApi) && !config.databaseUrl) {
    throw new Error(
      "DATABASE_URL is required when ENABLE_API=1 or DO_BACKGROUND_WORK=1"
    )
  }

  if (config.doBackgroundWork && !config.rpcWsUrl) {
    throw new Error("RPC_WS_URL is required when DO_BACKGROUND_WORK=1")
  }

  if (config.doBackgroundWork && !config.oracleApiUrl) {
    throw new Error("ORACLE_API_URL is required when DO_BACKGROUND_WORK=1")
  }
}

const allowUnauthenticatedApi = resolveBoolean(
  process.env.ALLOW_UNAUTHENTICATED_API,
  false
)
const authApiKey = process.env.AUTH_API_KEY
const apiRequested = resolveBoolean(process.env.ENABLE_API, false)

export const config: RuntimeConfig = {
  allowUnauthenticatedApi,
  apiRequested,
  authApiKey,
  batchSize: resolveNumber(process.env.BATCH_SIZE, 2000),
  confirmationBlocks: resolveNonNegativeInteger(
    process.env.CONFIRMATION_BLOCKS,
    12
  ),
  databaseUrl: process.env.DATABASE_URL,
  depositoryBalanceAuditIntervalMs: resolveNonNegativeInteger(
    process.env.DEPOSITORY_BALANCE_AUDIT_INTERVAL_MS,
    10 * 60 * 1000
  ),
  doBackgroundWork: resolveBoolean(process.env.DO_BACKGROUND_WORK, true),
  enableApi: resolveEnableApi(
    apiRequested,
    authApiKey,
    allowUnauthenticatedApi
  ),
  healthMaxLagBlocks: resolveNumber(process.env.HEALTH_MAX_LAG_BLOCKS, 500),
  hubContractAddress: resolveAddress(
    process.env.HUB_CONTRACT_ADDRESS,
    relayNetworkDefaults.hubContractAddress
  ),
  hubStartBlock: resolveNumber(
    process.env.HUB_START_BLOCK,
    resolveNumber(process.env.START_BLOCK, relayNetworkDefaults.startBlock)
  ),
  indexerAuditConsecutiveFailures: resolveNonNegativeInteger(
    process.env.INDEXER_AUDIT_CONSECUTIVE_FAILURES,
    2
  ),
  indexerAuditFailureThreshold: resolveNonNegativeInteger(
    process.env.INDEXER_AUDIT_FAILURE_THRESHOLD,
    1
  ),
  indexerAuditIntervalMs: resolveNonNegativeInteger(
    process.env.INDEXER_AUDIT_INTERVAL_MS,
    15 * 60 * 1000
  ),
  indexerAuditMaxAgeMs: resolveNonNegativeInteger(
    process.env.INDEXER_AUDIT_MAX_AGE_MS,
    30 * 60 * 1000
  ),
  maxTransferReplayBlockRange: resolveNumber(
    process.env.MAX_TRANSFER_REPLAY_BLOCK_RANGE,
    100_000
  ),
  oracleApiKey: process.env.ORACLE_API_KEY,
  oracleApiUrl: process.env.ORACLE_API_URL,
  oracleContractAddress: resolveAddress(
    process.env.ORACLE_CONTRACT_ADDRESS,
    relayNetworkDefaults.oracleContractAddress
  ),
  oracleStartBlock: resolveNumber(
    process.env.ORACLE_START_BLOCK,
    resolveNumber(process.env.START_BLOCK, relayNetworkDefaults.startBlock)
  ),
  pollIntervalMs: resolveNumber(process.env.POLL_INTERVAL_MS, 5000),
  port: resolvePort(process.env.PORT),
  priceOracleContractAddress: resolveAddress(
    process.env.PRICE_ORACLE_CONTRACT_ADDRESS,
    relayNetworkDefaults.priceOracleContractAddress
  ),
  rpcHttpUrl: process.env.RPC_HTTP_URL,
  rpcWsUrl: process.env.RPC_WS_URL,
  startBlock: resolveNumber(
    process.env.START_BLOCK,
    relayNetworkDefaults.startBlock
  ),
  transferCoverageAuditLookbackBlocks: resolveNonNegativeInteger(
    process.env.TRANSFER_COVERAGE_AUDIT_LOOKBACK_BLOCKS,
    5000
  ),
  transferOverlapBlocks: resolveNonNegativeInteger(
    process.env.TRANSFER_OVERLAP_BLOCKS,
    250
  ),
}
