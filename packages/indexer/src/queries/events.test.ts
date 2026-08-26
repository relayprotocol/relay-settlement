import assert from "node:assert/strict"
import test from "node:test"
import { MemoryCacheBackend, type CacheBackend } from "../cache.js"
import type { Database } from "../db/connection.js"
import type { TransferStatRow } from "../models/db.js"
import { createTransferStatsService } from "./events.js"

const NOW = Date.UTC(2026, 7, 18, 12)
const rows: TransferStatRow[] = [{ bucket: "2026-08-18", count: 3 }]
const silentLogger = {
  debug: () => undefined,
  error: () => undefined,
}

const createDb = (query: () => Promise<TransferStatRow[]>) =>
  ({ manyOrNone: query }) as unknown as Database

const defaultArgs = {
  granularity: "day",
  points: 30,
  tzOffsetMinutes: 0,
}

test("transfer stats caches the final query result on misses and hits", async () => {
  let queries = 0
  const db = createDb(async () => {
    queries += 1
    return rows
  })
  const transferStats = createTransferStatsService(db, {
    cache: new MemoryCacheBackend(() => NOW),
    logger: silentLogger,
    now: () => NOW,
  })

  assert.deepEqual(await transferStats(defaultArgs), rows)
  assert.deepEqual(await transferStats(defaultArgs), rows)
  assert.equal(queries, 1)
})

test("transfer stats cache entries expire after ten minutes", async () => {
  let cacheNow = NOW
  let queries = 0
  const db = createDb(async () => {
    queries += 1
    return [{ bucket: "2026-08-18", count: queries }]
  })
  const transferStats = createTransferStatsService(db, {
    cache: new MemoryCacheBackend(() => cacheNow),
    logger: silentLogger,
    now: () => NOW,
  })

  assert.equal((await transferStats(defaultArgs))[0]?.count, 1)
  cacheNow += 10 * 60 * 1000 - 1
  assert.equal((await transferStats(defaultArgs))[0]?.count, 1)
  cacheNow += 2
  assert.equal((await transferStats(defaultArgs))[0]?.count, 2)
  assert.equal(queries, 2)
})

test("transfer stats cache keys include normalized result inputs", async () => {
  const keys: string[] = []
  let queryNow = NOW
  const cache: CacheBackend = {
    get: async () => null,
    set: async (key) => {
      keys.push(key)
    },
  }
  const transferStats = createTransferStatsService(
    createDb(async () => rows),
    {
      cache,
      logger: silentLogger,
      now: () => queryNow,
    }
  )

  await transferStats(defaultArgs)
  await transferStats({ ...defaultArgs, granularity: "hour" })
  await transferStats({ ...defaultArgs, tzOffsetMinutes: 60 })
  await transferStats({ ...defaultArgs, points: 31 })
  await transferStats({ ...defaultArgs, tokenId: "relay-token-1" })
  queryNow += 10 * 60 * 1000
  await transferStats(defaultArgs)

  assert.equal(new Set(keys).size, 6)
  assert.ok(
    keys.every((key) => /^indexer:transfer-stats:v1:[a-f0-9]{64}$/.test(key))
  )
})

test("transfer stats cache keys normalize equivalent parameters", async () => {
  let queries = 0
  const transferStats = createTransferStatsService(
    createDb(async () => {
      queries += 1
      return rows
    }),
    {
      cache: new MemoryCacheBackend(() => NOW),
      logger: silentLogger,
      now: () => NOW,
    }
  )

  await transferStats({
    granularity: "unsupported",
    points: 999,
    tzOffsetMinutes: 60.9,
  })
  await transferStats({
    granularity: "day",
    points: 365,
    tzOffsetMinutes: 60,
  })

  assert.equal(queries, 1)
})

test("transfer stats coalesces concurrent cache misses", async () => {
  let queries = 0
  let releaseQuery: (() => void) | undefined
  const queryGate = new Promise<void>((resolve) => {
    releaseQuery = resolve
  })
  const transferStats = createTransferStatsService(
    createDb(async () => {
      queries += 1
      await queryGate
      return rows
    }),
    {
      cache: new MemoryCacheBackend(() => NOW),
      logger: silentLogger,
      now: () => NOW,
    }
  )

  const first = transferStats(defaultArgs)
  const second = transferStats(defaultArgs)
  await Promise.resolve()
  assert.equal(queries, 1)

  releaseQuery?.()
  assert.deepEqual(await Promise.all([first, second]), [rows, rows])
  assert.equal(queries, 1)
})

test("transfer stats falls back to the database when the cache fails", async () => {
  let queries = 0
  let cacheErrors = 0
  const cache: CacheBackend = {
    get: async () => {
      throw new Error("cache unavailable")
    },
    set: async () => {
      throw new Error("cache unavailable")
    },
  }
  const transferStats = createTransferStatsService(
    createDb(async () => {
      queries += 1
      return rows
    }),
    {
      cache,
      logger: {
        debug: () => undefined,
        error: () => {
          cacheErrors += 1
        },
      },
      now: () => NOW,
    }
  )

  assert.deepEqual(await transferStats(defaultArgs), rows)
  assert.deepEqual(await transferStats(defaultArgs), rows)
  assert.equal(queries, 2)
  assert.equal(cacheErrors, 4)
})

test("transfer stats does not cache database errors", async () => {
  let queries = 0
  let writes = 0
  const cache: CacheBackend = {
    get: async () => null,
    set: async () => {
      writes += 1
    },
  }
  const transferStats = createTransferStatsService(
    createDb(async () => {
      queries += 1
      if (queries === 1) {
        throw new Error("database unavailable")
      }
      return rows
    }),
    { cache, logger: silentLogger, now: () => NOW }
  )

  await assert.rejects(() => transferStats(defaultArgs), /database unavailable/)
  assert.deepEqual(await transferStats(defaultArgs), rows)
  assert.equal(queries, 2)
  assert.equal(writes, 1)
})
