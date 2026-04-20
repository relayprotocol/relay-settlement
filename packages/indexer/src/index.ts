import { createServer } from "./server.js"
import { config } from "./config.js"
import { logger } from "./logger.js"

const start = async () => {
  const app = createServer()
  app.listen(config.port, () => {
    logger.info("app", "Indexer shell listening", { port: config.port })
  })
}

start().catch((error) => {
  logger.error("app", "Failed to start indexer shell", { error })
  process.exit(1)
})
