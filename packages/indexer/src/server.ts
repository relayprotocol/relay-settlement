import express from "express"
import { createApiKeyMiddleware } from "./auth.js"
import { type RuntimeState } from "./runtimeState.js"

export const createServer = (
  runtimeState: RuntimeState,
  expectedApiKey?: string
) => {
  const app = express()

  app.use(express.json())

  app.get("/health", (_req, res) => {
    res.json(runtimeState.getLiveness())
  })

  app.get("/ready", (_req, res) => {
    const readiness = runtimeState.getReadiness()
    res.status(readiness.ok ? 200 : 503).json(readiness)
  })

  app.get("/", (_req, res) => {
    res.json({
      message: "Indexer event ingestion core is running.",
      ok: true,
      roles: runtimeState.roles,
    })
  })

  if (!runtimeState.enableApi) {
    return app
  }

  app.use(createApiKeyMiddleware(expectedApiKey))

  app.get("/api/config", (_req, res) => {
    res.json({
      authEnabled: Boolean(expectedApiKey),
      doBackgroundWork: runtimeState.doBackgroundWork,
      enableApi: runtimeState.enableApi,
      mode: "event-ingestion-core",
    })
  })

  return app
}
