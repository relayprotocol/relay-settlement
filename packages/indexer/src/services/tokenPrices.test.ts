import assert from "node:assert/strict"
import test from "node:test"
import { ZeroAddress } from "ethers"
import { TokenPriceService, type PriceOracleReader } from "./tokenPrices.js"

const PROVIDER_ID = "0x" + "11".repeat(32)
const FEED_ID = "0x" + "22".repeat(32)
const ADAPTER = "0x" + "33".repeat(20)
const NOW = 1_788_260_000_000

const createReader = (
  overrides: Partial<PriceOracleReader> = {}
): PriceOracleReader => ({
  feedRoutes: async () => [PROVIDER_ID, FEED_ID, 18n, 60n, true],
  getFunction: () => ({
    staticCall: async () => [
      3500n * 10n ** 18n,
      18n,
      18n,
      1_788_260_000n,
      1_788_260_060n,
    ],
  }),
  priceFeedAdapters: async () => ADAPTER,
  ...overrides,
})

test("returns an available exact fixed-point price", async () => {
  const service = new TokenPriceService(createReader(), { now: () => NOW })

  assert.deepEqual(await service.getPrice("123"), {
    adapterConfigured: true,
    currencyDecimals: 18,
    expiration: "1788260060",
    feedId: FEED_ID,
    maxAgeSeconds: 60,
    observedAt: "2026-09-01T10:53:20.000Z",
    providerId: PROVIDER_ID,
    publishTime: "1788260000",
    routeConfigured: true,
    status: "available",
    tokenId: "123",
    usdPrice: "3500000000000000000000",
    usdPriceDecimals: 18,
  })
})

test("distinguishes an unconfigured route", async () => {
  let adapterReads = 0
  const service = new TokenPriceService(
    createReader({
      feedRoutes: async () => [ZeroAddress, ZeroAddress, 0n, 0n, false],
      priceFeedAdapters: async () => {
        adapterReads += 1
        return ADAPTER
      },
    }),
    { now: () => NOW }
  )

  const result = await service.getPrice("456")

  assert.equal(result.status, "unconfigured")
  assert.equal(result.routeConfigured, false)
  assert.equal(result.adapterConfigured, false)
  assert.equal(result.usdPrice, null)
  assert.equal(adapterReads, 0)
})

test("reports a configured route without an adapter as unavailable", async () => {
  const service = new TokenPriceService(
    createReader({ priceFeedAdapters: async () => ZeroAddress }),
    { now: () => NOW }
  )

  const result = await service.getPrice("789")

  assert.equal(result.status, "unavailable")
  assert.equal(result.routeConfigured, true)
  assert.equal(result.adapterConfigured, false)
})

test("isolates price resolution failures from route configuration", async () => {
  const service = new TokenPriceService(
    createReader({
      getFunction: () => ({
        staticCall: async () => {
          throw new Error("price expired")
        },
      }),
    }),
    { now: () => NOW }
  )

  const result = await service.getPrice("101112")

  assert.equal(result.status, "unavailable")
  assert.equal(result.routeConfigured, true)
  assert.equal(result.adapterConfigured, true)
  assert.equal(result.usdPrice, null)
})

test("reports route read failures without calling them unconfigured", async () => {
  const service = new TokenPriceService(
    createReader({
      feedRoutes: async () => {
        throw new Error("rpc unavailable")
      },
    }),
    { now: () => NOW }
  )

  const result = await service.getPrice("131415")

  assert.equal(result.status, "error")
  assert.equal(result.routeConfigured, null)
  assert.equal(result.adapterConfigured, null)
})

test("caches reads and coalesces concurrent requests", async () => {
  let routeReads = 0
  const reader = createReader({
    feedRoutes: async () => {
      routeReads += 1
      await Promise.resolve()
      return [PROVIDER_ID, FEED_ID, 18n, 60n, true]
    },
  })
  const service = new TokenPriceService(reader, { now: () => NOW })

  const [first, second] = await Promise.all([
    service.getPrice("16"),
    service.getPrice("16"),
  ])
  const third = await service.getPrice("16")

  assert.deepEqual(first, second)
  assert.deepEqual(first, third)
  assert.equal(routeReads, 1)
})

test("does not cache an available price beyond its expiration", async () => {
  let now = NOW
  let routeReads = 0
  const service = new TokenPriceService(
    createReader({
      feedRoutes: async () => {
        routeReads += 1
        return [PROVIDER_ID, FEED_ID, 18n, 60n, true]
      },
      getFunction: () => ({
        staticCall: async () => [
          3500n * 10n ** 18n,
          18n,
          18n,
          1_788_260_000n,
          1_788_260_001n,
        ],
      }),
    }),
    { cacheTtlMs: 5000, now: () => now }
  )

  await service.getPrice("17")
  now += 1001
  await service.getPrice("17")

  assert.equal(routeReads, 2)
})
