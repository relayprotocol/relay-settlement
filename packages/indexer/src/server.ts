import type { Provider } from "ethers"
import express from "express"
import type { NextFunction, Request, Response } from "express"
import { createApiKeyMiddleware } from "./auth.js"
import { config } from "./config.js"
import type { Database } from "./db/connection.js"
import { listBalancesForAddress } from "./queries/balances.js"
import { createTransferStatsService, listEvents } from "./queries/events.js"
import { listHolders } from "./queries/holders.js"
import { getApprovedOracleInstances } from "./queries/oracles.js"
import { getProtocolTransactionsByHash } from "./queries/protocolTransactions.js"
import {
  getRoleAdmin,
  listRoleEvents,
  listRoleMembers,
  listRoleMembersForContract,
  listRolesForAccount,
} from "./queries/roles.js"
import {
  getToken,
  listTokenBalances,
  listTokens,
  searchTokensByName,
} from "./queries/tokens.js"
import {
  normalizeProtocolTransactionHashes,
  ProtocolTransactionRequestError,
} from "./protocol/transactionRequest.js"
import { getHealthStatus } from "./services/health.js"
import { getLatestIndexerAuditReport } from "./services/indexerAudit.js"
import { TransferReplayRequestError } from "./services/transferReplay.js"
import {
  createTransferReplayJobManager,
  TransferReplayJobConflictError,
} from "./services/transferReplayJobs.js"
import { type RuntimeState } from "./runtimeState.js"

const MAX_PAGE_LIMIT = 200
const DEFAULT_TRANSFER_REPLAY_RECONCILE_CHUNK_SIZE = 100

type AsyncHandler = (
  _req: Request,
  _res: Response,
  _next: NextFunction
) => Promise<unknown>

const parsePageLimit = (value: unknown, fallback: number) => {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = Number(raw)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.min(parsed, MAX_PAGE_LIMIT)
}

const parseTzOffsetMinutes = (value: unknown) => {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
}

const asyncHandler = (handler: AsyncHandler) => {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(handler(req, res, next)).catch(next)
  }
}

export const createServer = (
  runtimeState: RuntimeState,
  options: {
    db?: Database
    defaultTransferReplayBatchSize?: number
    expectedApiKey?: string
    healthProvider?: Provider
    hubContractAddress?: string
    maxTransferReplayBlockRange?: number
    oracleContractAddress?: string
    oracleProvider?: Provider
    replayProvider?: Provider
  } = {}
) => {
  const app = express()
  const {
    db,
    defaultTransferReplayBatchSize = 2000,
    expectedApiKey,
    healthProvider,
    hubContractAddress,
    maxTransferReplayBlockRange = 100_000,
    oracleContractAddress,
    oracleProvider,
    replayProvider,
  } = options

  app.use(express.json())

  app.get("/health", (_req, res) => {
    res.json(runtimeState.getLiveness())
  })

  const resolveSyncHealth = async () => {
    if (!db || !healthProvider) {
      return null
    }

    return getHealthStatus(db, healthProvider)
  }

  app.get("/ready", (_req, res) => {
    const readiness = runtimeState.getReadiness()
    res.status(readiness.ok ? 200 : 503).json(readiness)
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

  if (!db) {
    throw new Error("API mode requires a database connection")
  }

  const transferStats = createTransferStatsService(db)

  if (expectedApiKey && replayProvider && hubContractAddress) {
    const replayJobs = createTransferReplayJobManager({
      db,
      defaultBatchSize: defaultTransferReplayBatchSize,
      defaultReconcileChunkSize: DEFAULT_TRANSFER_REPLAY_RECONCILE_CHUNK_SIZE,
      hubContractAddress,
      maxBlockRange: maxTransferReplayBlockRange,
      provider: replayProvider,
    })
    const adminAuth = createApiKeyMiddleware(expectedApiKey, {
      pathPrefix: "/api/admin/",
    })

    app.post(
      "/api/admin/replay/transfers",
      adminAuth,
      asyncHandler(async (req, res) => {
        try {
          const job = replayJobs.start(req.body ?? {})
          return res.status(202).json(job)
        } catch (error) {
          if (error instanceof TransferReplayRequestError) {
            return res.status(400).json({ error: error.message })
          }

          if (error instanceof TransferReplayJobConflictError) {
            return res.status(409).json({ error: error.message })
          }

          throw error
        }
      })
    )

    app.get(
      "/api/admin/replay/transfers/:jobId",
      adminAuth,
      asyncHandler(async (req, res) => {
        const job = replayJobs.get(req.params.jobId)
        if (!job) {
          return res
            .status(404)
            .json({ error: "Transfer replay job not found" })
        }

        return res.json(job)
      })
    )
  }

  app.use(createApiKeyMiddleware(expectedApiKey))

  app.get("/api/config", (_req, res) => {
    res.json({
      authEnabled: Boolean(expectedApiKey),
      doBackgroundWork: runtimeState.doBackgroundWork,
      enableApi: runtimeState.enableApi,
      hubContractAddress,
      mode: "query-api",
      oracleContractAddress,
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

  app.get(
    "/api/audits/indexer/latest",
    asyncHandler(async (_req, res) => {
      const report = await getLatestIndexerAuditReport(db, {
        consecutiveFailures: config.indexerAuditConsecutiveFailures,
        failureThreshold: config.indexerAuditFailureThreshold,
        maxAgeMs: config.indexerAuditMaxAgeMs,
        maxReplayRange: maxTransferReplayBlockRange,
      })
      return res.json(report)
    })
  )

  app.get(
    "/api/tokens",
    asyncHandler(async (req, res) => {
      const limit = parsePageLimit(req.query.limit, 20)
      const cursor = req.query.cursor?.toString()
      const query = req.query.query?.toString()
      const { rows, nextCursor } = query
        ? await searchTokensByName(db, query, limit, cursor)
        : await listTokens(db, limit, cursor)
      return res.json({ data: rows, nextCursor })
    })
  )

  app.get(
    "/api/tokens/:id",
    asyncHandler(async (req, res) => {
      const row = await getToken(db, req.params.id)
      if (!row) {
        return res.status(404).json({ error: "Token not found" })
      }

      return res.json(row)
    })
  )

  app.get(
    "/api/tokens/:id/balances",
    asyncHandler(async (req, res) => {
      const limit = parsePageLimit(req.query.limit, 100)
      const cursor = req.query.cursor?.toString()
      const { rows, nextCursor } = await listTokenBalances(
        db,
        req.params.id,
        limit,
        cursor
      )
      return res.json({ data: rows, nextCursor })
    })
  )

  app.get(
    "/api/balances/:address",
    asyncHandler(async (req, res) => {
      const limit = parsePageLimit(req.query.limit, 100)
      const cursor = req.query.cursor?.toString()
      const { rows, nextCursor } = await listBalancesForAddress(
        db,
        req.params.address,
        limit,
        cursor
      )
      return res.json({ data: rows, nextCursor })
    })
  )

  app.get(
    "/api/holders",
    asyncHandler(async (req, res) => {
      const limit = parsePageLimit(req.query.limit, 100)
      const cursor = req.query.cursor?.toString()
      const { rows, nextCursor } = await listHolders(db, limit, cursor)
      return res.json({ data: rows, nextCursor })
    })
  )

  app.get(
    "/api/events",
    asyncHandler(async (req, res) => {
      const limit = parsePageLimit(req.query.limit, 100)
      const tokenId = req.query.tokenId?.toString()
      const address = req.query.address?.toString()?.toLowerCase()
      const cursor = req.query.cursor?.toString()

      const { rows, nextCursor } = await listEvents(db, {
        address,
        cursor,
        limit,
        tokenId,
      })
      return res.json({ data: rows, nextCursor })
    })
  )

  app.post(
    "/api/protocol/transactions/by-hash",
    asyncHandler(async (req, res) => {
      let normalizedTxHashes: string[]

      try {
        normalizedTxHashes = normalizeProtocolTransactionHashes(
          req.body?.txHashes
        )
      } catch (error) {
        if (error instanceof ProtocolTransactionRequestError) {
          return res.status(400).json({ error: error.message })
        }

        throw error
      }

      const data = await getProtocolTransactionsByHash(db, normalizedTxHashes)
      return res.json({ data })
    })
  )

  app.get(
    "/api/oracles/approved",
    asyncHandler(async (_req, res) => {
      if (!oracleProvider || !oracleContractAddress) {
        return res.status(503).json({
          error: "Oracle provider unavailable",
        })
      }

      return res.json(
        await getApprovedOracleInstances(
          db,
          oracleProvider,
          oracleContractAddress
        )
      )
    })
  )

  app.get(
    "/api/transfers/stats",
    asyncHandler(async (req, res) => {
      const granularity = String(req.query.granularity ?? "day")
      const pointsRaw = Number(req.query.points ?? "0")
      const points =
        Number.isFinite(pointsRaw) && pointsRaw > 0
          ? Math.min(pointsRaw, 365)
          : 30
      const tzOffsetMinutes = parseTzOffsetMinutes(req.query.tzOffsetMinutes)
      const rows = await transferStats({
        granularity,
        points,
        tzOffsetMinutes,
      })
      return res.json({ data: rows, granularity, points })
    })
  )

  app.get(
    "/api/tokens/:id/transfer-stats",
    asyncHandler(async (req, res) => {
      const granularity = String(req.query.granularity ?? "day")
      const pointsRaw = Number(req.query.points ?? "0")
      const points =
        Number.isFinite(pointsRaw) && pointsRaw > 0
          ? Math.min(pointsRaw, 365)
          : 30
      const tzOffsetMinutes = parseTzOffsetMinutes(req.query.tzOffsetMinutes)
      const rows = await transferStats({
        granularity,
        points,
        tokenId: req.params.id,
        tzOffsetMinutes,
      })
      return res.json({ data: rows, granularity, points })
    })
  )

  app.get(
    "/api/roles/events",
    asyncHandler(async (req, res) => {
      const limit = parsePageLimit(req.query.limit, 100)
      const contractAddress = req.query.contract?.toString()
      if (!contractAddress) {
        return res.status(400).json({ error: "Missing contract parameter" })
      }

      const role = req.query.role?.toString()
      const account = req.query.account?.toString()
      const cursor = req.query.cursor?.toString()
      const { rows, nextCursor } = await listRoleEvents(db, {
        account,
        contractAddress,
        cursor,
        limit,
        role,
      })
      return res.json({ data: rows, nextCursor })
    })
  )

  app.get(
    "/api/roles/:role/members",
    asyncHandler(async (req, res) => {
      const limit = parsePageLimit(req.query.limit, 100)
      const contractAddress = req.query.contract?.toString()
      if (!contractAddress) {
        return res.status(400).json({ error: "Missing contract parameter" })
      }

      const cursor = req.query.cursor?.toString()
      const { rows, nextCursor } = await listRoleMembers(
        db,
        contractAddress,
        req.params.role,
        limit,
        cursor
      )
      return res.json({ data: rows, nextCursor })
    })
  )

  app.get(
    "/api/roles/:role/admin",
    asyncHandler(async (req, res) => {
      const contractAddress = req.query.contract?.toString()
      if (!contractAddress) {
        return res.status(400).json({ error: "Missing contract parameter" })
      }

      const row = await getRoleAdmin(db, contractAddress, req.params.role)
      if (!row) {
        return res.status(404).json({ error: "Role admin not found" })
      }

      return res.json(row)
    })
  )

  app.get(
    "/api/accounts/:address/roles",
    asyncHandler(async (req, res) => {
      const limit = parsePageLimit(req.query.limit, 100)
      const contractAddress = req.query.contract?.toString()
      if (!contractAddress) {
        return res.status(400).json({ error: "Missing contract parameter" })
      }

      const cursor = req.query.cursor?.toString()
      const { rows, nextCursor } = await listRolesForAccount(
        db,
        contractAddress,
        req.params.address,
        limit,
        cursor
      )
      return res.json({ data: rows, nextCursor })
    })
  )

  app.get(
    "/api/roles",
    asyncHandler(async (req, res) => {
      const contractAddress = req.query.contract?.toString()
      if (!contractAddress) {
        return res.status(400).json({ error: "Missing contract parameter" })
      }

      const rows = await listRoleMembersForContract(db, contractAddress)
      const byRole = new Map<string, string[]>()
      rows.forEach((row) => {
        const current = byRole.get(row.role) ?? []
        current.push(row.account)
        byRole.set(row.role, current)
      })
      const data = Array.from(byRole.entries()).map(([role, members]) => ({
        members,
        role,
      }))
      return res.json({ data })
    })
  )

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  )

  return app
}
