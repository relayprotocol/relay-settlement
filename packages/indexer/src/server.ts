import type { Provider } from "ethers"
import express from "express"
import { createApiKeyMiddleware } from "./auth.js"
import type { Database } from "./db/connection.js"
import { getHealthStatus } from "./services/health.js"
import { type RuntimeState } from "./runtimeState.js"

export const createServer = (
  runtimeState: RuntimeState,
  options: {
    db?: Database
    expectedApiKey?: string
    healthProvider?: Provider
  } = {}
) => {
  const app = express()
  const { db, expectedApiKey, healthProvider } = options

  app.use(express.json())

  app.get("/health", (_req, res) => {
    res.json(runtimeState.getLiveness())
  })

  const resolveSyncHealth = async () => {
    if (!runtimeState.doBackgroundWork || !db || !healthProvider) {
      return null
    }

    return getHealthStatus(db, healthProvider)
  }

  app.get("/ready", async (_req, res) => {
    const readiness = runtimeState.getReadiness()

    try {
      const sync = await resolveSyncHealth()
      const ok = readiness.ok && (sync?.ok ?? true)
      res
        .status(ok ? 200 : 503)
        .json(sync ? { ...readiness, ok, sync } : readiness)
    } catch (error) {
      res.status(503).json({
        ...readiness,
        ok: false,
        sync: {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
        },
      })
    }
  })

  app.get("/", (_req, res) => {
    res.json({
      message: "Settlement indexer is running.",
      ok: true,
      roles: runtimeState.roles,
    })
  })

  app.get("/sync-health", async (_req, res) => {
    try {
      const sync = await resolveSyncHealth()
      if (!sync) {
        return res.json({
          enabled: false,
          ok: true,
        })
      }

      return res.status(sync.ok ? 200 : 503).json(sync)
    } catch (error) {
      return res.status(503).json({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      })
    }
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
      mode: "retry-and-health-jobs",
    })
  })

  app.get("/api/health", async (_req, res) => {
    try {
      const sync = await resolveSyncHealth()
      if (!sync) {
        return res.json({
          enabled: false,
          ok: true,
        })
      }

      return res.status(sync.ok ? 200 : 503).json(sync)
    } catch (error) {
      return res.status(503).json({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      })
    }
  })

  return app
}
