import { RelayPriceOracle } from "@relay-protocol/settlement-abis"
import { Contract, ZeroAddress, type Provider } from "ethers"

const DEFAULT_CACHE_TTL_MS = 5000
const DEFAULT_CONCURRENCY = 10

export type TokenPriceStatus =
  | "available"
  | "error"
  | "unavailable"
  | "unconfigured"

export type TokenPrice = {
  adapterConfigured: boolean | null
  currencyDecimals: number | null
  expiration: string | null
  feedId: string | null
  maxAgeSeconds: number | null
  observedAt: string
  providerId: string | null
  publishTime: string | null
  routeConfigured: boolean | null
  status: TokenPriceStatus
  tokenId: string
  usdPrice: string | null
  usdPriceDecimals: number | null
}

type PriceOracleFunction = {
  staticCall(_tokenId: string): Promise<unknown>
}

export type PriceOracleReader = {
  feedRoutes(_tokenId: string): Promise<unknown>
  getFunction(_signature: string): PriceOracleFunction
  priceFeedAdapters(_providerId: string): Promise<unknown>
}

type CachedPrice = {
  expiresAt: number
  value: TokenPrice
}

type TokenPriceServiceOptions = {
  cacheTtlMs?: number
  concurrency?: number
  now?: () => number
}

const readResultField = (result: unknown, name: string, index: number) => {
  if (typeof result !== "object" || result == null) {
    return undefined
  }

  const fields = result as Record<string, unknown>
  return fields[name] ?? fields[String(index)]
}

const unavailablePrice = (
  tokenId: string,
  observedAt: string,
  overrides: Partial<TokenPrice> = {}
): TokenPrice => ({
  adapterConfigured: null,
  currencyDecimals: null,
  expiration: null,
  feedId: null,
  maxAgeSeconds: null,
  observedAt,
  providerId: null,
  publishTime: null,
  routeConfigured: null,
  status: "error",
  tokenId,
  usdPrice: null,
  usdPriceDecimals: null,
  ...overrides,
})

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (_item: T) => Promise<R>
) => {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index] as T)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () =>
      worker()
    )
  )
  return results
}

export class TokenPriceService {
  private readonly cache = new Map<string, CachedPrice>()
  private readonly cacheTtlMs: number
  private readonly concurrency: number
  private readonly inFlight = new Map<string, Promise<TokenPrice>>()
  private readonly now: () => number
  private readonly priceOracle: PriceOracleReader

  constructor(
    priceOracle: PriceOracleReader,
    options: TokenPriceServiceOptions = {}
  ) {
    this.priceOracle = priceOracle
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.concurrency = Math.max(
      1,
      Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY)
    )
    this.now = options.now ?? Date.now
  }

  async getPrices(tokenIds: string[]) {
    return mapWithConcurrency(tokenIds, this.concurrency, (tokenId) =>
      this.getPrice(tokenId)
    )
  }

  async getPrice(tokenId: string): Promise<TokenPrice> {
    const now = this.now()
    const cached = this.cache.get(tokenId)
    if (cached && cached.expiresAt > now) {
      return cached.value
    }

    const current = this.inFlight.get(tokenId)
    if (current) {
      return current
    }

    const request = this.readPrice(tokenId, now)
      .then((value) => {
        const expiresAt = this.getCacheExpiration(value)
        if (expiresAt > this.now()) {
          this.cache.set(tokenId, {
            expiresAt,
            value,
          })
        }
        return value
      })
      .finally(() => {
        this.inFlight.delete(tokenId)
      })

    this.inFlight.set(tokenId, request)
    return request
  }

  private getCacheExpiration(price: TokenPrice) {
    const defaultExpiration = this.now() + this.cacheTtlMs
    if (!price.expiration) {
      return defaultExpiration
    }

    const expirationMs = Number(BigInt(price.expiration) * 1000n)
    return Math.min(defaultExpiration, expirationMs)
  }

  private async readPrice(tokenId: string, observedAtMs: number) {
    const observedAt = new Date(observedAtMs).toISOString()
    let route: unknown

    try {
      route = await this.priceOracle.feedRoutes(tokenId)
    } catch {
      return unavailablePrice(tokenId, observedAt)
    }

    const routeConfigured = Boolean(readResultField(route, "exists", 4))
    if (!routeConfigured) {
      return unavailablePrice(tokenId, observedAt, {
        adapterConfigured: false,
        routeConfigured: false,
        status: "unconfigured",
      })
    }

    const providerId = String(readResultField(route, "providerId", 0))
    const feedId = String(readResultField(route, "feedId", 1))
    const currencyDecimals = Number(
      readResultField(route, "currencyDecimals", 2)
    )
    const maxAgeSeconds = Number(readResultField(route, "maxAgeSeconds", 3))
    const routeFields = {
      currencyDecimals,
      feedId,
      maxAgeSeconds,
      providerId,
      routeConfigured: true,
    }

    let adapter: string
    try {
      adapter = String(await this.priceOracle.priceFeedAdapters(providerId))
    } catch {
      return unavailablePrice(tokenId, observedAt, routeFields)
    }

    const adapterConfigured = adapter.toLowerCase() !== ZeroAddress
    if (!adapterConfigured) {
      return unavailablePrice(tokenId, observedAt, {
        ...routeFields,
        adapterConfigured: false,
        status: "unavailable",
      })
    }

    try {
      const result = await this.priceOracle
        .getFunction("resolveUsdPrice(uint256)")
        .staticCall(tokenId)

      return {
        ...routeFields,
        adapterConfigured: true,
        expiration: String(readResultField(result, "expiration", 4)),
        observedAt,
        publishTime: String(readResultField(result, "publishTime", 3)),
        status: "available" as const,
        tokenId,
        usdPrice: String(readResultField(result, "usdPrice", 0)),
        usdPriceDecimals: Number(
          readResultField(result, "usdPriceDecimals", 1)
        ),
      }
    } catch {
      return unavailablePrice(tokenId, observedAt, {
        ...routeFields,
        adapterConfigured: true,
        status: "unavailable",
      })
    }
  }
}

export const createTokenPriceService = (
  provider: Provider,
  priceOracleContractAddress: string,
  options: TokenPriceServiceOptions = {}
) =>
  new TokenPriceService(
    new Contract(
      priceOracleContractAddress,
      RelayPriceOracle,
      provider
    ) as unknown as PriceOracleReader,
    options
  )
