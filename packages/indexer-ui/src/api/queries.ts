import { keepPreviousData, queryOptions } from "@tanstack/react-query"
import { REFRESH_INTERVAL_MS } from "../queryClient"
import { api, unwrap } from "./client"
import type {
  Alert,
  AlertSeverity,
  Chain,
  DepositoryStats,
  IndexedRoleChange,
  ListContractEventsResponse,
  RescanRequest,
  ResolvedPrice,
  TransferKind,
  WithdrawalKind,
} from "./schema"

const MINUTE = 60_000
const HUB = "default"
const CONTRACT = "default"
const PAGE_LIMIT = 100
const PRICE_BATCH = 20

export const PAGE_SIZE = 20
export const CHART_HOURS = 24
export const CHART_BUCKET_MINUTES = 15
export const RESCANS_KEY = ["indexer", "rescans"] as const

const pageStaleTime = (
  cursor: string | undefined,
  staleTime = REFRESH_INTERVAL_MS / 2
) => (cursor ? Infinity : staleTime)

const allPages = async <T>(
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>
) => {
  const first = await fetchPage(1)
  const rest = await Promise.all(
    Array.from(
      { length: Math.max(0, Math.ceil(first.total / PAGE_LIMIT) - 1) },
      (_, index) => fetchPage(index + 2)
    )
  )
  return [first, ...rest].flatMap((page) => page.items)
}

const allCursorPages = async <T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; next?: string | null }>
) => {
  const items: T[] = []
  for (let cursor: string | undefined; ; ) {
    const page = await fetchPage(cursor)
    items.push(...page.items)
    if (!page.next) return items
    cursor = page.next
  }
}

type PriceWaiter = {
  resolve: (price: ResolvedPrice | null) => void
  reject: (error: unknown) => void
}

let pendingPrices: Map<string, PriceWaiter[]> | undefined

const flushPrices = () => {
  const pending = pendingPrices ?? new Map<string, PriceWaiter[]>()
  pendingPrices = undefined
  const tokens = [...pending.keys()]
  for (let start = 0; start < tokens.length; start += PRICE_BATCH) {
    const batch = tokens.slice(start, start + PRICE_BATCH)
    const waiters = batch.flatMap((token) =>
      (pending.get(token) ?? []).map((waiter) => ({ token, waiter }))
    )
    unwrap(
      api.GET("/prices", { params: { query: { assets: batch.join(",") } } })
    ).then(
      ({ prices }) => {
        const byToken = new Map(
          prices.map((price) => [price.asset.token_id, price])
        )
        for (const { token, waiter } of waiters)
          waiter.resolve(byToken.get(token) ?? null)
      },
      (error: unknown) => {
        for (const { waiter } of waiters) waiter.reject(error)
      }
    )
  }
}

const batchedPrice = (token: string) =>
  new Promise<ResolvedPrice | null>((resolve, reject) => {
    if (!pendingPrices) {
      pendingPrices = new Map()
      setTimeout(flushPrices, 10)
    }
    pendingPrices.set(token, [
      ...(pendingPrices.get(token) ?? []),
      { reject, resolve },
    ])
  })

export const priceQueries = {
  all: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        allPages(async (page) => {
          const { prices, pagination } = await unwrap(
            api.GET("/prices", {
              params: { query: { page, page_size: PAGE_LIMIT } },
              signal,
            })
          )
          return {
            items: prices,
            total: pagination.total_items,
          }
        }),
      queryKey: ["price-list"],
      staleTime: 5 * MINUTE,
    }),
  price: (token: string) =>
    queryOptions({
      meta: { quiet: true },
      queryFn: () => batchedPrice(token),
      queryKey: ["prices", token],
      staleTime: 5 * MINUTE,
    }),
  source: (source: string) =>
    queryOptions({
      meta: { quiet: true },
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/prices/sources/{source}", {
            params: { path: { source } },
            signal,
          })
        ),
      queryKey: ["price-sources", source],
      staleTime: MINUTE,
    }),
  sources: () =>
    queryOptions({
      queryFn: ({ signal }) => unwrap(api.GET("/prices/sources", { signal })),
      queryKey: ["price-sources"],
      staleTime: 10 * MINUTE,
    }),
}

const PRICE_ORACLE = "default"

export const priceOracleQueries = {
  events: (cursor?: string) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/price-oracles/{price_oracle}/events", {
            params: {
              path: { price_oracle: PRICE_ORACLE },
              query: { cursor, page_size: PAGE_SIZE },
            },
            signal,
          })
        ),
      queryKey: ["price-oracle", "events", cursor],
      staleTime: pageStaleTime(cursor, 5 * MINUTE),
    }),
  feeds: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        allPages(async (page) => {
          const { feeds, pagination } = await unwrap(
            api.GET("/protocol/price-oracles/{price_oracle}/feeds", {
              params: {
                path: { price_oracle: PRICE_ORACLE },
                query: { page, page_size: PAGE_LIMIT },
              },
              signal,
            })
          )
          return { items: feeds, total: pagination.total_items }
        }),
      queryKey: ["price-oracle", "feeds"],
      staleTime: MINUTE,
    }),
  feedStats: (asset: string) =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(
          api.GET(
            "/protocol/price-oracles/{price_oracle}/feeds/{asset}/statistics",
            {
              params: {
                path: { asset, price_oracle: PRICE_ORACLE },
                query: {
                  bucket_minutes: CHART_BUCKET_MINUTES,
                  hours: CHART_HOURS,
                },
              },
              signal,
            }
          )
        ),
      queryKey: ["price-oracle", "feed-stats", asset],
      staleTime: MINUTE,
    }),
  providers: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/price-oracles/{price_oracle}/providers", {
            params: {
              path: { price_oracle: PRICE_ORACLE },
              query: { page_size: PAGE_LIMIT },
            },
            signal,
          })
        ),
      queryKey: ["price-oracle", "providers"],
      staleTime: 5 * MINUTE,
    }),
}

export const indexerQueries = {
  bindings: () =>
    queryOptions({
      queryFn: ({ signal }) => unwrap(api.GET("/indexer/bindings", { signal })),
      queryKey: ["indexer", "bindings"],
      staleTime: MINUTE,
    }),
  activeAlerts: (kind: Alert["kind"]) =>
    queryOptions({
      queryFn: ({ signal }) =>
        allPages(async (page) => {
          const { alerts, pagination } = await unwrap(
            api.GET("/indexer/alerts", {
              params: {
                query: { kind, active: true, page, page_size: PAGE_LIMIT },
              },
              signal,
            })
          )
          return { items: alerts, total: pagination.total_items }
        }),
      queryKey: ["indexer", "alerts", kind, "active"],
      staleTime: MINUTE / 2,
    }),
  config: () =>
    queryOptions({
      queryFn: ({ signal }) => unwrap(api.GET("/indexer/config", { signal })),
      queryKey: ["indexer", "config"],
      staleTime: 10 * MINUTE,
    }),
  database: () =>
    queryOptions({
      queryFn: ({ signal }) => unwrap(api.GET("/indexer/database", { signal })),
      queryKey: ["indexer", "database"],
      staleTime: MINUTE / 2,
    }),
  alerts: (
    page: number,
    filters: {
      kind?: Alert["kind"]
      chain?: Chain
      active?: boolean
      resolved?: boolean
      severity?: AlertSeverity
    } = {},
    pageSize = PAGE_SIZE
  ) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/indexer/alerts", {
            params: { query: { ...filters, page, page_size: pageSize } },
            signal,
          })
        ),
      queryKey: ["indexer", "alerts", filters, page, pageSize],
      staleTime: MINUTE / 2,
    }),
  rescans: (page: number) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/indexer/rescans", {
            params: {
              query: { automatic: false, page, page_size: PAGE_SIZE },
            },
            signal,
          })
        ),
      queryKey: [...RESCANS_KEY, page],
    }),
  snapshots: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(api.GET("/indexer/snapshots", { signal })),
      queryKey: ["indexer", "snapshots"],
      staleTime: MINUTE / 2,
    }),
  status: () =>
    queryOptions({
      queryFn: ({ signal }) => unwrap(api.GET("/indexer/status", { signal })),
      queryKey: ["indexer", "status"],
    }),
}

export const submitRescan = (body: RescanRequest) =>
  unwrap(api.POST("/indexer/rescans", { body }))

export const cancelRescan = (rescan: string) =>
  unwrap(
    api.POST("/indexer/rescans/{rescan}/cancel", {
      params: { path: { rescan } },
    })
  )

export type StatsWindow = { bucketMinutes: number; hours: number }

export const DAY_WINDOW: StatsWindow = {
  bucketMinutes: CHART_BUCKET_MINUTES,
  hours: CHART_HOURS,
}

const fetchTransferStats = (
  filter: { origin_chain?: string },
  { bucketMinutes, hours }: StatsWindow,
  signal: AbortSignal
) =>
  unwrap(
    api.GET("/protocol/hubs/{hub}/transfers/statistics", {
      params: {
        path: { hub: HUB },
        query: { ...filter, bucket_minutes: bucketMinutes, hours },
      },
      signal,
    })
  )

export type TransferFilter = {
  account?: string
  kind?: TransferKind
  tokenId?: string
  txHash?: string
}

export const hubQueries = {
  wallets: (cursor?: string) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/hubs/{hub}/wallets", {
            params: {
              path: { hub: HUB },
              query: { cursor, page_size: 10 },
            },
            signal,
          })
        ),
      queryKey: ["hub", "wallets", cursor],
      staleTime: MINUTE,
    }),
  wallet: (wallet: string) =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/hubs/{hub}/wallets/{wallet}", {
            params: { path: { hub: HUB, wallet } },
            signal,
          })
        ),
      queryKey: ["hub", "wallet", wallet],
      staleTime: MINUTE,
    }),
  deficits: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        allPages(async (page) => {
          const { deficits, pagination } = await unwrap(
            api.GET("/protocol/hubs/{hub}/deficits", {
              params: {
                path: { hub: HUB },
                query: { page, page_size: PAGE_LIMIT },
              },
              signal,
            })
          )
          return { items: deficits, total: pagination.total_items }
        }),
      queryKey: ["hub", "deficits"],
      staleTime: MINUTE,
    }),
  holders: (token: string, cursor?: string) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/hubs/{hub}/tokens/{token}/holders", {
            params: {
              path: { hub: HUB, token },
              query: { cursor, page_size: PAGE_SIZE },
            },
            signal,
          })
        ),
      queryKey: ["hub", "holders", token, cursor],
      staleTime: pageStaleTime(cursor, MINUTE),
    }),
  roleChanges: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        allCursorPages<IndexedRoleChange>(async (cursor) => {
          const { changes, pagination } = await unwrap(
            api.GET("/protocol/hubs/{hub}/roles/changes", {
              params: {
                path: { hub: HUB },
                query: { cursor, page_size: PAGE_LIMIT },
              },
              signal,
            })
          )
          return { items: changes, next: pagination.next_cursor }
        }),
      queryKey: ["hub", "role-changes"],
      staleTime: 5 * MINUTE,
    }),
  state: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/hubs/{hub}/state", {
            params: { path: { hub: HUB } },
            signal,
          })
        ),
      queryKey: ["hub", "state"],
      staleTime: MINUTE,
    }),
  token: (token: string) =>
    queryOptions({
      meta: { inline: true },
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/hubs/{hub}/tokens/{token}", {
            params: { path: { hub: HUB, token } },
            signal,
          })
        ),
      queryKey: ["hub", "token", token],
      staleTime: 15 * MINUTE,
    }),
  tokenState: (token: string) =>
    queryOptions({
      meta: { quiet: true },
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/hubs/{hub}/tokens/{token}/state", {
            params: { path: { hub: HUB, token } },
            signal,
          })
        ),
      queryKey: ["hub", "token-state", token],
      staleTime: 15 * MINUTE,
    }),
  tokens: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        allPages(async (page) => {
          const { tokens, pagination } = await unwrap(
            api.GET("/protocol/hubs/{hub}/tokens", {
              params: {
                path: { hub: HUB },
                query: { page, page_size: PAGE_LIMIT },
              },
              signal,
            })
          )
          return { items: tokens, total: pagination.total_items }
        }),
      queryKey: ["hub", "tokens"],
      staleTime: 15 * MINUTE,
    }),
  originStats: (chain: string) =>
    queryOptions({
      queryFn: ({ signal }) =>
        fetchTransferStats({ origin_chain: chain }, DAY_WINDOW, signal),
      queryKey: ["hub", "transfer-stats", chain],
      staleTime: MINUTE,
    }),
  transferStats: (scale = DAY_WINDOW) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) => fetchTransferStats({}, scale, signal),
      queryKey: ["hub", "transfer-stats", scale],
      staleTime: MINUTE,
    }),
  transfers: (
    { account, kind, tokenId, txHash }: TransferFilter,
    cursor?: string
  ) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/hubs/{hub}/transfers", {
            params: {
              path: { hub: HUB },
              query: {
                account,
                cursor,
                kind,
                page_size: PAGE_SIZE,
                token_id: tokenId,
                tx_hash: txHash,
              },
            },
            signal,
          })
        ),
      queryKey: ["hub", "transfers", account, kind, tokenId, txHash, cursor],
      staleTime: pageStaleTime(cursor),
    }),
  walletBalances: (wallet: string, cursor?: string) =>
    queryOptions({
      meta: { inline: true },
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/hubs/{hub}/wallets/{wallet}/balances", {
            params: {
              path: { hub: HUB, wallet },
              query: { cursor, page_size: PAGE_SIZE },
            },
            signal,
          })
        ),
      queryKey: ["hub", "wallet-balances", wallet, cursor],
      staleTime: pageStaleTime(cursor, MINUTE),
    }),
}

type EventQuery = { cursor?: string; kind?: string; page_size: number }

const contractQueries = <State>(
  name: string,
  fetchState: (signal: AbortSignal) => Promise<State>,
  fetchEvents: (
    query: EventQuery,
    signal: AbortSignal
  ) => Promise<ListContractEventsResponse>
) => ({
  events: (kind?: string, cursor?: string) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        fetchEvents({ cursor, kind, page_size: PAGE_SIZE }, signal),
      queryKey: [name, "events", kind, cursor],
      staleTime: pageStaleTime(cursor, MINUTE),
    }),
  state: () =>
    queryOptions({
      queryFn: ({ signal }) => fetchState(signal),
      queryKey: [name, "state"],
      staleTime: MINUTE,
    }),
})

export type ContractEventsQuery = ReturnType<
  ReturnType<typeof contractQueries>["events"]
>

export const oracleQueries = {
  ...contractQueries(
    "oracle",
    (signal) =>
      unwrap(
        api.GET("/protocol/oracles/{oracle}/state", {
          params: { path: { oracle: CONTRACT } },
          signal,
        })
      ),
    (query, signal) =>
      unwrap(
        api.GET("/protocol/oracles/{oracle}/events", {
          params: { path: { oracle: CONTRACT }, query },
          signal,
        })
      )
  ),
  executions: (cursor?: string, signer?: string) =>
    queryOptions({
      gcTime: signer ? 5 * MINUTE : undefined,
      placeholderData: signer ? undefined : keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/oracles/{oracle}/executions", {
            params: {
              path: { oracle: CONTRACT },
              query: { cursor, page_size: PAGE_SIZE, signer },
            },
            signal,
          })
        ),
      queryKey: ["oracle", "executions", cursor, signer],
      staleTime: signer ? Infinity : pageStaleTime(cursor, MINUTE),
    }),
  peers: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/oracles/{oracle}/peers", {
            params: { path: { oracle: CONTRACT } },
            signal,
          })
        ),
      queryKey: ["oracle", "peers"],
      staleTime: MINUTE,
    }),
}

export const allocatorQueries = {
  ...contractQueries(
    "allocator",
    (signal) =>
      unwrap(
        api.GET("/protocol/allocators/{allocator}/state", {
          params: { path: { allocator: CONTRACT } },
          signal,
        })
      ),
    (query, signal) =>
      unwrap(
        api.GET("/protocol/allocators/{allocator}/events", {
          params: { path: { allocator: CONTRACT }, query },
          signal,
        })
      )
  ),
  suspensions: () =>
    queryOptions({
      meta: { inline: true },
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/allocators/{allocator}/suspensions", {
            params: { path: { allocator: CONTRACT } },
            signal,
          })
        ),
      queryKey: ["allocator", "suspensions"],
      staleTime: MINUTE,
    }),
}

export const poolQueries = {
  list: () =>
    queryOptions({
      queryFn: ({ signal }) => unwrap(api.GET("/protocol/pools", { signal })),
      queryKey: ["pools"],
      staleTime: MINUTE,
    }),
}

export const xerc20Queries = (pool: string) => ({
  ...contractQueries(
    `xerc20:${pool}`,
    (signal) =>
      unwrap(
        api.GET("/protocol/pools/{pool}/state", {
          params: { path: { pool } },
          signal,
        })
      ),
    (query, signal) =>
      unwrap(
        api.GET("/protocol/pools/{pool}/events", {
          params: { path: { pool }, query },
          signal,
        })
      )
  ),
  lockboxes: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/pools/{pool}/lockboxes", {
            params: { path: { pool } },
            signal,
          })
        ),
      queryKey: [`xerc20:${pool}`, "lockboxes"],
    }),
  stats: (scale = DAY_WINDOW) =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/protocol/pools/{pool}/statistics", {
            params: {
              path: { pool },
              query: {
                bucket_minutes: scale.bucketMinutes,
                hours: scale.hours,
              },
            },
            signal,
          })
        ),
      queryKey: [`xerc20:${pool}`, "stats", scale],
      staleTime: scale.hours > CHART_HOURS ? 10 * MINUTE : MINUTE,
    }),
})

export const executorQueries = contractQueries(
  "executor",
  (signal) =>
    unwrap(
      api.GET("/protocol/executors/{executor}/state", {
        params: { path: { executor: CONTRACT } },
        signal,
      })
    ),
  (query, signal) =>
    unwrap(
      api.GET("/protocol/executors/{executor}/events", {
        params: { path: { executor: CONTRACT }, query },
        signal,
      })
    )
)

export type OriginFilter = {
  account?: string
  token?: string
  txHash?: string
}

type WithdrawalFilter = OriginFilter & { kind?: WithdrawalKind }

export type DepositoryRef = { chain: string; depository: string }

const fetchDepositoryBalances = (
  { chain, depository }: DepositoryRef,
  signal: AbortSignal
) =>
  allPages(async (page) => {
    const { balances, pagination } = await unwrap(
      api.GET("/chains/{chain}/depositories/{depository}/balances", {
        params: {
          path: { chain, depository },
          query: { page, page_size: PAGE_LIMIT },
        },
        signal,
      })
    )
    return { items: balances, total: pagination.total_items }
  })

export const chainQueries = {
  depositories: () =>
    queryOptions({
      queryFn: ({ signal }) =>
        unwrap(api.GET("/protocol/depositories", { signal })),
      queryKey: ["chains", "depositories"],
      staleTime: MINUTE,
    }),
  balances: (chain: string, depository: string) =>
    queryOptions({
      queryFn: ({ signal }) =>
        fetchDepositoryBalances({ chain, depository }, signal),
      queryKey: ["origin", chain, depository, "balances"],
      staleTime: MINUTE,
    }),
  deposits: (
    chain: string,
    depository: string,
    { account, token, txHash }: OriginFilter,
    cursor?: string
  ) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/chains/{chain}/depositories/{depository}/deposits", {
            params: {
              path: { chain, depository },
              query: {
                cursor,
                page_size: PAGE_SIZE,
                sender: account,
                token,
                tx_hash: txHash,
              },
            },
            signal,
          })
        ),
      queryKey: [
        "origin",
        chain,
        depository,
        "deposits",
        account,
        token,
        txHash,
        cursor,
      ],
      staleTime: pageStaleTime(cursor),
    }),
  activityStats: (chain: string, depository: string, scale = DAY_WINDOW) =>
    queryOptions({
      placeholderData: (previous: DepositoryStats | undefined, query) =>
        query?.queryKey[1] === chain && query.queryKey[2] === depository
          ? previous
          : undefined,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET(
            "/chains/{chain}/depositories/{depository}/activity/statistics",
            {
              params: {
                path: { chain, depository },
                query: {
                  bucket_minutes: scale.bucketMinutes,
                  hours: scale.hours,
                },
              },
              signal,
            }
          )
        ),
      queryKey: ["chains", chain, depository, "activity-stats", scale],
      staleTime: scale.hours > CHART_HOURS ? 10 * MINUTE : MINUTE,
    }),
  depository: (chain: string, depository: string) =>
    contractQueries(
      `origin:${chain}:${depository}`,
      (signal) =>
        unwrap(
          api.GET("/chains/{chain}/depositories/{depository}/state", {
            params: { path: { chain, depository } },
            signal,
          })
        ),
      (query, signal) =>
        unwrap(
          api.GET("/chains/{chain}/depositories/{depository}/events", {
            params: { path: { chain, depository }, query },
            signal,
          })
        )
    ),
  withdrawals: (
    chain: string,
    depository: string,
    { account, kind, token, txHash }: WithdrawalFilter,
    cursor?: string
  ) =>
    queryOptions({
      placeholderData: keepPreviousData,
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/chains/{chain}/depositories/{depository}/withdrawals", {
            params: {
              path: { chain, depository },
              query: {
                cursor,
                kind,
                page_size: PAGE_SIZE,
                recipient: account,
                token,
                tx_hash: txHash,
              },
            },
            signal,
          })
        ),
      queryKey: [
        "origin",
        chain,
        depository,
        "withdrawals",
        account,
        kind,
        token,
        txHash,
        cursor,
      ],
      staleTime: pageStaleTime(cursor),
    }),
}
