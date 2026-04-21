import dotenv from "dotenv"
import { relay } from "@relay-protocol/settlement-networks"

dotenv.config()

export type RuntimeConfig = {
  allowUnauthenticatedApi: boolean
  authApiKey: string | undefined
  databaseUrl: string | undefined
  doBackgroundWork: boolean
  enableApi: boolean
  hubContractAddress: string
  hubStartBlock: number
  oracleContractAddress: string
  oracleStartBlock: number
  port: number
  startBlock: number
}

const relayProdContracts = relay.contracts?.prod

if (
  relayProdContracts?.hub == null ||
  relayProdContracts.oracle == null ||
  relay.earliestBlock == null
) {
  throw new Error(
    "Relay network metadata is missing required deployment fields"
  )
}

export const relayNetworkDefaults = {
  hubContractAddress: relayProdContracts.hub.toLowerCase(),
  oracleContractAddress: relayProdContracts.oracle.toLowerCase(),
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

export const resolveNumber = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const validateRuntimeConfig = (config: RuntimeConfig) => {
  if (
    config.enableApi &&
    !config.authApiKey &&
    !config.allowUnauthenticatedApi
  ) {
    throw new Error(
      "AUTH_API_KEY is required when ENABLE_API=1 unless ALLOW_UNAUTHENTICATED_API=1"
    )
  }
}

export const config: RuntimeConfig = {
  allowUnauthenticatedApi: resolveBoolean(
    process.env.ALLOW_UNAUTHENTICATED_API,
    false
  ),
  authApiKey: process.env.AUTH_API_KEY,
  databaseUrl: process.env.DATABASE_URL,
  doBackgroundWork: resolveBoolean(process.env.DO_BACKGROUND_WORK, true),
  enableApi: resolveBoolean(process.env.ENABLE_API, true),
  hubContractAddress: resolveAddress(
    process.env.HUB_CONTRACT_ADDRESS,
    relayNetworkDefaults.hubContractAddress
  ),
  hubStartBlock: resolveNumber(
    process.env.HUB_START_BLOCK,
    resolveNumber(process.env.START_BLOCK, relayNetworkDefaults.startBlock)
  ),
  oracleContractAddress: resolveAddress(
    process.env.ORACLE_CONTRACT_ADDRESS,
    relayNetworkDefaults.oracleContractAddress
  ),
  oracleStartBlock: resolveNumber(
    process.env.ORACLE_START_BLOCK,
    resolveNumber(process.env.START_BLOCK, relayNetworkDefaults.startBlock)
  ),
  port: resolvePort(process.env.PORT),
  startBlock: resolveNumber(
    process.env.START_BLOCK,
    relayNetworkDefaults.startBlock
  ),
}
