import { RelayOracle } from "@relay-protocol/settlement-abis"
import { Contract, JsonRpcProvider, WebSocketProvider } from "ethers"
import { openDb } from "./db/connection.js"
import { backfillAndWatch } from "./indexer.js"
import { createServer } from "./server.js"
import { config, validateRuntimeConfig } from "./config.js"
import { createRuntimeState } from "./runtimeState.js"
import { logger } from "./logger.js"

const start = async () => {
  validateRuntimeConfig(config)

  if (!config.enableApi && !config.doBackgroundWork) {
    throw new Error(
      "Nothing to run: enable ENABLE_API and/or DO_BACKGROUND_WORK"
    )
  }

  if (config.enableApi && !config.authApiKey) {
    logger.warn("app", "API auth is disabled by explicit configuration", {
      allowUnauthenticatedApi: config.allowUnauthenticatedApi,
    })
  }

  const runtimeState = createRuntimeState({
    doBackgroundWork: config.doBackgroundWork,
    enableApi: config.enableApi,
  })

  const app = createServer(runtimeState, config.authApiKey)
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

  const db = await openDb()
  const provider = config.rpcHttpUrl
    ? new JsonRpcProvider(config.rpcHttpUrl)
    : new WebSocketProvider(config.rpcWsUrl as string)
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

  runtimeState.markBackgroundWorkReady()
  backfillAndWatch(db).catch((error) => {
    runtimeState.markBackgroundWorkUnready(error)
    logger.error("indexer", "Indexer stopped", { error })
  })
}

start().catch((error) => {
  logger.error("app", "Failed to start indexer", { error })
  process.exit(1)
})
