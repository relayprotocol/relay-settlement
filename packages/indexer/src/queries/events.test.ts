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
  info: () => undefined,
}
const createDb = (query: () => Promise<TransferStatRow[]>) =>
  ({ manyOrNone: query }) as unknown as Database
const args = { granularity: "day", points: 30, tzOffsetMinutes: 0 }

const fixture = (
  query: () => Promise<TransferStatRow[]>,
  cache?: CacheBackend
) => {
  let now = NOW
  const service = createTransferStatsService(createDb(query), {
    cache: cache ?? new MemoryCacheBackend(() => now),
    logger: silentLogger,
    now: () => now,
  })
  return {
    advance: (ms: number) => {
      now += ms
    },
    service,
  }
}

test("stats reuse successful results and refresh across ten-minute boundaries", async () => {
  let calls = 0
  const { service, advance } = fixture(async () => [
    { ...rows[0]!, count: ++calls },
  ])
  assert.equal((await service(args)).rows[0]?.count, 1)
  advance(599_999)
  assert.equal((await service(args)).rows[0]?.count, 1)
  advance(1)
  assert.equal((await service(args)).rows[0]?.count, 2)
  assert.equal(calls, 2)
})

test("cache identity isolates result parameters and normalizes equivalents", async () => {
  let calls = 0
  const { service } = fixture(async () => {
    calls++
    return rows
  })
  await service(args)
  await service({ ...args, granularity: "hour" })
  await service({ ...args, tzOffsetMinutes: 60 })
  await service({ ...args, points: 31 })
  await service({ ...args, tokenId: "1" })
  await service({
    granularity: "unsupported",
    points: 999,
    tzOffsetMinutes: 60.9,
  })
  await service({ granularity: "day", points: 365, tzOffsetMinutes: 60 })
  assert.equal(calls, 6)
})

test("cold requests queue behind bounded refreshes and same-key requests coalesce", async () => {
  let calls = 0
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { service } = fixture(async () => {
    calls++
    await gate
    return rows
  })
  const first = service(args)
  const duplicate = service(args)
  const second = service({ ...args, tokenId: "2" })
  const third = service({ ...args, tokenId: "3" })
  await new Promise(setImmediate)
  assert.equal(calls, 2)
  release()
  const results = await Promise.all([first, duplicate, second, third])
  assert.deepEqual(results[0], results[1])
  assert.equal(calls, 3)
})

test("cold refresh queues have a capacity and deadline without leaking slots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let calls = 0
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { service } = fixture(async () => {
    calls++
    await gate
    return rows
  })
  const active = [service(args), service({ ...args, tokenId: "1" })]
  const waiting = Array.from({ length: 8 }, (_, i) =>
    assert.rejects(
      service({ ...args, tokenId: String(i + 2) }),
      /temporarily unavailable/
    )
  )
  await assert.rejects(
    service({ ...args, tokenId: "overflow" }),
    /temporarily unavailable/
  )
  assert.equal(calls, 2)
  t.mock.timers.tick(2000)
  await Promise.all(waiting)
  const next = service({ ...args, tokenId: "next" })
  await new Promise(setImmediate)
  assert.equal(calls, 2)
  release()
  await Promise.all([...active, next])
  await service({ ...args, tokenId: "later" })
  assert.equal(calls, 4)
})

test("stale charts return immediately while cold refreshes occupy the slots", async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const { service, advance } = fixture(async () => {
    if (++calls > 1) await gate
    return rows
  })
  const cached = await service(args)
  advance(600_000)
  const active = [
    service({ ...args, tokenId: "1" }),
    service({ ...args, tokenId: "2" }),
  ]
  assert.deepEqual(await service(args), { ...cached, stale: true })
  assert.equal(calls, 3)
  release()
  await Promise.all(active)
})

test("timezone normalization bounds extreme offsets without rounding valid minutes", async () => {
  let calls = 0
  const { service } = fixture(async () => {
    calls++
    return rows
  })
  for (const tzOffsetMinutes of [840, 100000, -720, -100000, 1, 15])
    await service({ ...args, tzOffsetMinutes })
  assert.equal(calls, 4)
})

test("failures back off, preserve a bounded last good result, and then recover", async () => {
  let calls = 0
  let fail = false
  const { service, advance } = fixture(async () => {
    calls++
    if (fail) throw new Error("statement timeout")
    return rows
  })
  const initial = await service(args)
  fail = true
  advance(600_000)
  assert.deepEqual(await service(args), { ...initial, stale: true })
  await service(args)
  assert.equal(calls, 2)
  advance(30_000)
  await service(args)
  assert.equal(calls, 3)
  advance(1_200_000)
  await assert.rejects(service(args), /temporarily unavailable/)
  fail = false
  advance(30_000)
  assert.equal((await service(args)).stale, false)
})

test("cold failures never cache an empty success and do not retry immediately", async () => {
  let calls = 0
  const { service, advance } = fixture(async () => {
    if (++calls === 1) throw new Error("database unavailable")
    return []
  })
  await assert.rejects(service(args), /temporarily unavailable/)
  await assert.rejects(service(args), /temporarily unavailable/)
  assert.equal(calls, 1)
  advance(30_000)
  const result = await service(args)
  assert.deepEqual(result.rows, [])
  assert.equal(result.stale, false)
})

test("cache failures and malformed entries fall back to the bounded query", async () => {
  let calls = 0
  const failingCache: CacheBackend = {
    get: async () => {
      throw new Error("cache offline")
    },
    set: async () => {
      throw new Error("cache offline")
    },
  }
  const { service } = fixture(async () => {
    calls++
    return rows
  }, failingCache)
  assert.deepEqual((await service(args)).rows, rows)
  assert.deepEqual((await service(args)).rows, rows)
  assert.equal(calls, 2)
  const malformed = fixture(async () => rows, {
    get: async () => "null",
    set: async () => undefined,
  })
  assert.deepEqual((await malformed.service(args)).rows, rows)
})

test("memory cache evicts least recently used entries without extending read expiry", async () => {
  let now = NOW
  const cache = new MemoryCacheBackend(() => now, 2)
  await cache.set("a", "1", 100)
  await cache.set("b", "2", 100)
  now += 50
  assert.equal(await cache.get("a"), "1")
  await cache.set("c", "3", 100)
  assert.equal(await cache.get("b"), null)
  await cache.set("a", "updated", 50)
  await cache.set("d", "4", 50)
  assert.equal(await cache.get("c"), null)
  assert.equal(await cache.get("a"), "updated")
  now += 50
  assert.equal(await cache.get("a"), null)
  assert.equal(await cache.get("d"), null)
})
