import { createRuntimeState } from "./runtimeState.js"
import { createServer } from "./server.js"
import { config, validateRuntimeConfig } from "./config.js"
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

  if (config.enableApi) {
    runtimeState.markApiReady()
  }
  if (config.doBackgroundWork) {
    runtimeState.markBackgroundWorkReady()
  }

  const app = createServer(runtimeState, config.authApiKey)
  app.listen(config.port, () => {
    logger.info("app", "Indexer runtime shell listening", {
      doBackgroundWork: config.doBackgroundWork,
      enableApi: config.enableApi,
      port: config.port,
    })
  })
}

start().catch((error) => {
  logger.error("app", "Failed to start indexer runtime shell", { error })
  process.exit(1)
})
