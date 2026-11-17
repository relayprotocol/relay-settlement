import { keccak256, toHex, type Hex } from "viem"
import { describe, expect, it } from "vitest"

import {
  batchRoutes,
  checkServedFeeds,
  currencies,
  parseAllowedUnservedFeeds,
  parseEnv,
  routeTokenId,
  selectMissingRoutes,
  STORK_FEEDS,
  storkFeedId,
  storkPriceRoutes,
  type CurrentRoute,
  type FeedRoute,
  type StorkFeed,
} from "../scripts/generate-set-feed-routes"

const route = (
  chainId: string,
  currency: Hex,
  feed: StorkFeed = "USDCUSD",
  currencyDecimals = 6
): FeedRoute => ({
  currency: { chainId, currency },
  currencyDecimals,
  feed,
  feedId: storkFeedId(feed),
  label: `${chainId}-${feed}`,
  maxAgeSeconds: 30,
  providerId: keccak256(toHex("stork")),
})

const existing = (r: FeedRoute): CurrentRoute => [
  r.providerId,
  r.feedId,
  r.currencyDecimals,
  r.maxAgeSeconds,
  true,
]
const absent: CurrentRoute = [
  `0x${"00".repeat(32)}`,
  `0x${"00".repeat(32)}`,
  0,
  0,
  false,
]

const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex
const usdt = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Hex

describe("storkFeedId", () => {
  it("matches the ingester's fast_feed_id encoding", () => {
    // crates/stork-ingester/src/taxonomy.rs: fast_feed_id(1, 3)
    expect(storkFeedId("BTCUSD")).toBe(
      "0x2675065076b5e69b60497bd3cf1d151029073424bb8c5b65a5921da77beb6ad8"
    )
    expect(STORK_FEEDS.BTCUSD).toBe(3)
  })

  it("derives the route table without duplicates", () => {
    expect(storkPriceRoutes).toHaveLength(currencies.length)
    const tokenIds = new Set(storkPriceRoutes.map(routeTokenId))
    expect(tokenIds.size).toBe(storkPriceRoutes.length)
    for (const r of storkPriceRoutes) {
      expect(r.feedId).toBe(storkFeedId(r.feed))
      expect(r.maxAgeSeconds).toBe(30)
    }
  })

  it("encodes Lighter account indexes as 16-byte currencies", () => {
    const lighter = storkPriceRoutes.filter(
      (r) => r.currency.chainId === "lighter"
    )
    expect(lighter.map((r) => r.currency.currency).sort()).toEqual([
      "0x00000000000000000000000000000000",
      "0x00000000000000000000000000000001",
      "0x00000000000000000000000000000003",
    ])
  })
})

describe("selectMissingRoutes", () => {
  it("keeps absent routes and skips exact matches", () => {
    const a = route("ethereum", usdc)
    const b = route("ethereum", usdt, "USDTUSD")
    expect(selectMissingRoutes([a, b], [existing(a), absent])).toEqual([b])
  })

  it("rejects a conflicting existing route", () => {
    const a = route("ethereum", usdc)
    const conflicting: CurrentRoute = [
      a.providerId,
      storkFeedId("USDTUSD"),
      a.currencyDecimals,
      a.maxAgeSeconds,
      true,
    ]
    expect(() => selectMissingRoutes([a], [conflicting])).toThrow(
      /Conflicting existing route: ethereum-USDCUSD/
    )
    const wrongDecimals: CurrentRoute = [
      a.providerId,
      a.feedId,
      18,
      a.maxAgeSeconds,
      true,
    ]
    expect(() => selectMissingRoutes([a], [wrongDecimals])).toThrow(
      /Conflicting existing route/
    )
  })

  it("rejects duplicate currencies and length mismatches", () => {
    const a = route("ethereum", usdc)
    expect(() => selectMissingRoutes([a, a], [absent, absent])).toThrow(
      /Duplicate currency route/
    )
    expect(() => selectMissingRoutes([a], [])).toThrow(
      /Route result count mismatch/
    )
  })
})

describe("batchRoutes", () => {
  it("splits 111 routes into 32/32/32/15 with contiguous nonces", () => {
    const routes = Array.from({ length: 111 }, (_, i) =>
      route("ethereum", `0x${i.toString(16).padStart(40, "0")}` as Hex)
    )
    const batches = batchRoutes(routes, 211)
    expect(batches.map((b) => b.routes.length)).toEqual([32, 32, 32, 15])
    expect(batches.map((b) => b.nonce)).toEqual([211, 212, 213, 214])
    expect(batches.flatMap((b) => b.routes)).toEqual(routes)
  })

  it("returns no batches for no routes", () => {
    expect(batchRoutes([], 5)).toEqual([])
  })
})

describe("checkServedFeeds", () => {
  const routes = [
    route("ethereum", usdc, "USDCUSD"),
    route("ethereum", usdt, "USDTUSD"),
    route("solana", `0x${"11".repeat(32)}` as Hex, "CASHUSD"),
  ]
  const served = new Set<StorkFeed>(["USDCUSD", "USDTUSD"])

  it("fails on an unserved feed that is not allowed", () => {
    expect(() => checkServedFeeds(routes, served, new Set())).toThrow(
      /not served by the sequencer: CASHUSD/
    )
  })

  it("reports allowed unserved feeds instead of failing", () => {
    expect(
      checkServedFeeds(routes, served, parseAllowedUnservedFeeds("CASHUSD"))
    ).toEqual({ served: ["USDCUSD", "USDTUSD"], unserved: ["CASHUSD"] })
  })

  it("passes when every feed is served", () => {
    expect(checkServedFeeds(routes.slice(0, 2), served, new Set())).toEqual({
      served: ["USDCUSD", "USDTUSD"],
      unserved: [],
    })
  })
})

describe("parseAllowedUnservedFeeds", () => {
  it("parses a comma-separated list and rejects unknown symbols", () => {
    expect([...parseAllowedUnservedFeeds(" CASHUSD, DAIUSD ,")]).toEqual([
      "CASHUSD",
      "DAIUSD",
    ])
    expect([...parseAllowedUnservedFeeds(undefined)]).toEqual([])
    expect(() => parseAllowedUnservedFeeds("USDT0USD")).toThrow(
      /unknown Stork feed "USDT0USD"/
    )
  })
})

describe("parseEnv", () => {
  it("accepts the three deployment envs only", () => {
    expect(parseEnv("prod")).toBe("prod")
    expect(() => parseEnv("mainnet")).toThrow(/ENV must be one of/)
    expect(() => parseEnv(undefined)).toThrow(/ENV must be one of/)
  })
})
