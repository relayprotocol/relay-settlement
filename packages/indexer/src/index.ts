import { RelayHub, RelayOracle } from "@relay-protocol/settlement-abis"
import { Contract, JsonRpcProvider, WebSocketProvider } from "ethers"
import { config, validateRuntimeConfig } from "./config.js"
import { openDb } from "./db/connection.js"
import { backfillAndWatch } from "./indexer.js"
import { startDepositoryBalanceAudit } from "./jobs/depositoryBalanceAudit.js"
import { startFailedEventRetry } from "./jobs/failedEventRetry.js"
import { startIndexerAudit } from "./jobs/indexerAudit.js"
import { startReconciler } from "./jobs/reconciler.js"
import { logger } from "./logger.js"
import { createRuntimeState } from "./runtimeState.js"
import { createServer } from "./server.js"

const start = async () => {
  validateRuntimeConfig(config)

  if (!config.enableApi && !config.doBackgroundWork) {
    throw new Error(
      "Nothing to run: enable ENABLE_API and/or DO_BACKGROUND_WORK"
    )
  }

  if (config.apiRequested && !config.enableApi) {
    logger.warn("app", "API requested but disabled because auth is not set", {
      allowUnauthenticatedApi: config.allowUnauthenticatedApi,
      hasAuthApiKey: Boolean(config.authApiKey),
    })
  } else if (config.enableApi && !config.authApiKey) {
    logger.warn("app", "API auth is disabled by explicit configuration", {
      allowUnauthenticatedApi: config.allowUnauthenticatedApi,
    })
  }

  logger.info("app", "Runtime roles", {
    doBackgroundWork: config.doBackgroundWork,
    enableApi: config.enableApi,
  })

  const runtimeState = createRuntimeState({
    doBackgroundWork: config.doBackgroundWork,
    enableApi: config.enableApi,
  })

  const db =
    config.doBackgroundWork || config.enableApi ? await openDb() : undefined
  const provider =
    config.doBackgroundWork || config.enableApi
      ? config.rpcHttpUrl
        ? new JsonRpcProvider(config.rpcHttpUrl)
        : config.rpcWsUrl
          ? new WebSocketProvider(config.rpcWsUrl)
          : undefined
      : undefined

  if (provider) {
    const oracleContract = new Contract(
      config.oracleContractAddress,
      RelayOracle,
      provider
    )
    const linkedHub = String(await oracleContract.HUB()).toLowerCase()

    if (linkedHub !== config.hubContractAddress) {
      throw new Error(
        `Configured hub ${config.hubContractAddress} does not match oracle.HUB() ${linkedHub}`
      )
    }
  }

  const app = createServer(runtimeState, {
    db,
    defaultTransferReplayBatchSize: config.batchSize,
    expectedApiKey: config.authApiKey,
    healthProvider: provider,
    hubContractAddress: config.hubContractAddress,
    maxTransferReplayBlockRange: config.maxTransferReplayBlockRange,
    oracleContractAddress: config.oracleContractAddress,
    oracleProvider: provider,
    replayProvider: provider,
  })
  app.listen(config.port, () => {
    if (config.enableApi) {
      runtimeState.markApiReady()
    }

    logger.info("app", "Indexer listening", {
      doBackgroundWork: config.doBackgroundWork,
      enableApi: config.enableApi,
      port: config.port,
    })
  })

  if (!config.doBackgroundWork) {
    return
  }

  if (!db || !provider) {
    throw new Error("Background work requires a database and rpc provider")
  }

  const oracleContract = new Contract(
    config.oracleContractAddress,
    RelayOracle,
    provider
  )

  try {
    backfillAndWatch(db).catch((error) => {
      runtimeState.markBackgroundWorkUnready(error)
      logger.error("indexer", "Indexer stopped", { error })
    })
    startReconciler(db)
    const retryContract = new Contract(
      config.hubContractAddress,
      RelayHub,
      provider
    )
    startFailedEventRetry(
      db,
      provider,
      {
        hubContract: retryContract,
        hubContractAddress: config.hubContractAddress,
        oracleContract,
        oracleContractAddress: config.oracleContractAddress,
        oracleExecutionContext: {
          oracleContractAddress: config.oracleContractAddress,
          provider,
          transactionCache: new Map(),
        },
      },
      new Map()
    )
    startIndexerAudit(db, provider, retryContract)
    startDepositoryBalanceAudit(db, retryContract)
    runtimeState.markBackgroundWorkReady()
  } catch (error) {
    runtimeState.markBackgroundWorkUnready(error as Error)
    throw error
  }
}

start().catch((error) => {
  logger.error("app", "Failed to start indexer", { error })
  process.exit(1)
})
