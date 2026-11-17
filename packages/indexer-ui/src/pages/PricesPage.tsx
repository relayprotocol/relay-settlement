import { useState } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { priceOracleQueries, priceQueries } from "../api/queries"
import type {
  PriceAsset,
  PriceFeed,
  PriceFeedProvider,
  PriceQuote,
  PriceSourceInfo,
  PriceStatus,
  Reconciliation,
  ResolvedPrice,
} from "../api/schema"
import { eventColumns, eventRowKey } from "../components/events"
import {
  AddressLink,
  HashText,
  OriginChain,
  TokenLink,
  TxLink,
} from "../components/links"
import {
  CursorPager,
  ListPager,
  useCursorPages,
  useListPages,
} from "../components/pagination"
import { FeedCharts } from "../components/PriceCharts"
import {
  DeviationBadge,
  PRICE_ERROR_HINTS,
  PRICE_STATUS_TONES,
  priceExpired,
  PriceStatusBadge,
  StalenessBadge,
  stalenessRank,
} from "../components/status"
import { PRICE_SOURCE_NAMES, SourcedPrice, Usd } from "../components/Usd"
import {
  Badge,
  DataTable,
  Muted,
  Panel,
  RelativeTime,
  SearchInput,
  SegmentedControl,
  Card,
  TitleCount,
  type Column,
} from "../components/ui"
import { Tooltip } from "../components/Tooltip"
import { providerName, useLabels } from "../labels"
import { useSearch } from "../search"
import {
  capitalize,
  displayTokenLabel,
  formatDuration,
  formatNumber,
  shortTokenId,
  trimUrl,
  unixTime,
} from "../utils"

const STATUS_SEVERITY: PriceStatus[] = [
  "error",
  "unavailable",
  "stale",
  "unsupported",
  "available",
]

const ORACLE_STATUS_HINTS: Record<PriceStatus, string> = {
  available: "Oracle returns a current price",
  error: "Oracle price read failed",
  stale: "Oracle price not refreshed",
  unavailable: "Oracle has no current price",
  unsupported: "Oracle has no route",
}

const RECONCILIATION_HINTS: Record<Reconciliation, string> = {
  conflict: "Snapshot differs from events",
  event: "From indexed events only",
  pending: "Event awaits next snapshot",
  snapshot: "From the snapshot only",
  unknown: "Provider has no known configuration",
  verified: "Events match the snapshot",
}

const RECONCILIATION_TONES = {
  conflict: "error",
  event: "neutral",
  pending: "warning",
  snapshot: "neutral",
  unknown: "warning",
  verified: "success",
} as const satisfies Record<Reconciliation, string>

const RECONCILIATION_ISSUES: Reconciliation[] = [
  "conflict",
  "pending",
  "unknown",
]

type Row = {
  asset: PriceAsset
  resolved: ResolvedPrice
  quotes: Record<string, PriceQuote | undefined>
  deviation?: { value: number; title: string }
}

const feedPrice = (feed: PriceFeed) =>
  feed.last_price
    ? Number(feed.last_price.usd_price) /
      10 ** feed.last_price.usd_price_decimals
    : undefined

const quotePrice = (quote: PriceQuote) =>
  quote.status === "available" && quote.usd_price
    ? Number(quote.usd_price)
    : undefined

const assetLabel = (asset: { name?: string | null; symbol?: string | null }) =>
  displayTokenLabel(asset.name, asset.symbol)

const worstStatus = (statuses: PriceStatus[]) =>
  STATUS_SEVERITY.find((status) => statuses.includes(status)) ?? "unavailable"

const formatSeconds = (seconds?: number | null) =>
  seconds == null ? <Muted /> : formatDuration(seconds * 1000)

const quoteTitle = (quote?: PriceQuote) =>
  quote
    ? [capitalize(quote.status), quote.error?.message]
        .filter(Boolean)
        .join(": ")
    : "No quote"

const deviation = (quotes: PriceQuote[]) => {
  const [primary, secondary] = quotes.flatMap((quote) => {
    const price = quotePrice(quote)
    return price ? [{ price, source: quote.source }] : []
  })
  if (!primary || !secondary) return undefined
  return {
    title: `Sources: ${primary.source} vs ${secondary.source}`,
    value: (primary.price - secondary.price) / secondary.price,
  }
}

const priceRows = (prices: ResolvedPrice[]): Row[] =>
  prices
    .map((resolved) => ({
      asset: resolved.asset,
      deviation: deviation(resolved.quotes),
      quotes: Object.fromEntries(
        resolved.quotes.map((quote) => [quote.source, quote])
      ),
      resolved,
    }))
    .toSorted((a, b) => assetLabel(a.asset).localeCompare(assetLabel(b.asset)))

function Sources({
  sources,
  rows,
  error,
}: {
  sources?: PriceSourceInfo[]
  rows?: Row[]
  error?: Error | null
}) {
  const health = new Map(
    useQueries({
      queries: (sources ?? []).map((source) => priceQueries.source(source.id)),
    }).map((result, index) => [sources?.[index]?.id, result.data?.health])
  )
  const coverage = (id: string) =>
    rows ? (
      formatNumber(
        rows.filter((row) => row.quotes[id]?.status === "available").length
      )
    ) : (
      <Muted>...</Muted>
    )

  const columns: Column<PriceSourceInfo>[] = [
    {
      cell: (source) => (
        <Tooltip
          content={
            source.kind === "contract"
              ? source.contract_address
              : trimUrl(source.url)
          }
        >
          <span>{PRICE_SOURCE_NAMES[source.kind]}</span>
        </Tooltip>
      ),
      header: "Source",
      title: "Price contract or API",
    },
    {
      align: "right",
      cell: (source) => source.priority,
      header: "Priority",
      title: "Lowest is used first",
    },
    {
      align: "right",
      cell: (source) => coverage(source.id),
      header: "Tokens",
      title: "Tokens with a price",
    },
    {
      align: "right",
      cell: (source) => {
        const sourceHealth = health.get(source.id)
        return sourceHealth ? (
          <RelativeTime value={sourceHealth.last_success_at} />
        ) : (
          <Muted>...</Muted>
        )
      },
      header: "Last update",
      title: "Last successful update",
    },
  ]

  return (
    <Panel title="Sources">
      <DataTable
        columns={columns}
        rows={sources}
        rowKey={(source) => source.id}
        empty="No price sources configured"
        error={error}
      />
    </Panel>
  )
}

type FeedGroup = {
  feedId: string
  providerId: string
  routes: PriceFeed[]
}

const groupFeeds = (feeds: PriceFeed[]) => {
  const groups = new Map<string, FeedGroup>()
  for (const feed of feeds) {
    const key = `${feed.provider_id}:${feed.feed_id}`
    const group = groups.get(key) ?? {
      feedId: feed.feed_id,
      providerId: feed.provider_id,
      routes: [],
    }
    group.routes.push(feed)
    groups.set(key, group)
  }
  return [...groups.values()]
}

const feedSymbol = ({ routes }: FeedGroup) =>
  [
    ...new Set(
      routes.flatMap((route) => route.symbol?.split("-").at(-1) ?? [])
    ),
  ].join("/") || undefined

const latestRoute = ({ routes }: FeedGroup) =>
  routes
    .filter((route) => route.status === "available" && route.last_price)
    .sort(
      (a, b) =>
        Number(b.last_price?.publish_time) - Number(a.last_price?.publish_time)
    )[0]

const feedStatus = (routes: PriceFeed[]) => {
  const errors = [...new Set(routes.flatMap((route) => route.error ?? []))]
  const reconciliation = routes.find((route) =>
    RECONCILIATION_ISSUES.includes(route.reconciliation)
  )?.reconciliation
  const status = worstStatus(
    routes.map((route) => route.status ?? "unavailable")
  )
  const expired =
    status === "unavailable" &&
    routes
      .filter((route) => (route.status ?? "unavailable") === status)
      .every(priceExpired)
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <PriceStatusBadge
        status={status}
        title={
          errors.length
            ? errors.map((error) => PRICE_ERROR_HINTS[error]).join(". ")
            : ORACLE_STATUS_HINTS[status]
        }
        expired={expired}
      />
      {reconciliation ? (
        <Badge
          tone={RECONCILIATION_TONES[reconciliation]}
          title={RECONCILIATION_HINTS[reconciliation]}
        >
          {capitalize(reconciliation)}
        </Badge>
      ) : null}
    </span>
  )
}

const FEED_COLUMNS: Column<FeedGroup>[] = [
  {
    cell: (group) => feedSymbol(group) ?? <HashText value={group.feedId} />,
    header: "Asset",
    title: "Feed asset symbol or ID",
    sortValue: feedSymbol,
  },
  {
    cell: (group) => <HashText value={group.feedId} />,
    header: "Feed ID",
    title: "Price feed identifier",
  },
  {
    cell: (group) => (
      <Tooltip content={group.providerId}>
        <span>{providerName(group.providerId)}</span>
      </Tooltip>
    ),
    header: "Provider",
    title: "Price feed provider",
  },
  {
    cell: (group) => feedStatus(group.routes),
    header: "Status",
    title: "Feed availability and reconciliation",
  },
  {
    align: "right",
    cell: (group) => formatNumber(group.routes.length),
    header: "Routes",
    title: "Configured token routes",
    sortValue: (group) => group.routes.length,
  },
  {
    align: "right",
    cell: (group) => {
      const route = latestRoute(group)
      const price = route && feedPrice(route)
      return price == null ? <Muted /> : <Usd value={price} price />
    },
    header: "Price",
    title: "Feed price in USD",
    sortValue: (group) => {
      const route = latestRoute(group)
      return route && feedPrice(route)
    },
  },
  {
    align: "right",
    cell: (group) => (
      <RelativeTime
        value={unixTime(latestRoute(group)?.last_price?.publish_time)}
      />
    ),
    header: "Published",
    title: "Price publish time",
  },
]

const routeLabel = (route: PriceFeed) => assetLabel(route)

const sortRoutes = (feeds: PriceFeed[]) =>
  feeds.toSorted((a, b) => routeLabel(a).localeCompare(routeLabel(b)))

const sortSources = ({ sources }: { sources: PriceSourceInfo[] }) =>
  sources.toSorted((a, b) => a.priority - b.priority)

const PROVIDER_COLUMNS: Column<PriceFeedProvider>[] = [
  {
    cell: (provider) => (
      <Tooltip content={provider.provider_id}>
        <span>{providerName(provider.provider_id)}</span>
      </Tooltip>
    ),
    header: "Provider",
    title: "Price feed provider",
  },
  {
    cell: (provider) => <HashText value={provider.provider_id} />,
    header: "Provider ID",
    title: "Price provider identifier",
  },
  {
    cell: (provider) =>
      provider.adapter ? <AddressLink address={provider.adapter} /> : <Muted />,
    header: "Adapter",
    title: "Provider adapter contract",
  },
  {
    align: "right",
    cell: (provider) => formatSeconds(provider.max_future_seconds),
    header: "Max future",
    title: "Max publish time ahead",
  },
  {
    align: "right",
    cell: (provider) => formatNumber(provider.feed_count),
    header: "Routes",
    title: "Feeds using provider",
  },
  {
    cell: (provider) => (
      <RelativeTime value={provider.configuration_event?.block_timestamp} />
    ),
    header: "Configured",
    title: "Adapter configuration time",
  },
  {
    cell: (provider) => <TxLink hash={provider.configuration_event?.tx_hash} />,
    header: "Transaction",
    title: "Provider configuration transaction hash",
  },
  {
    cell: (provider) => (
      <Badge
        tone={RECONCILIATION_TONES[provider.reconciliation]}
        title={RECONCILIATION_HINTS[provider.reconciliation]}
      >
        {capitalize(provider.reconciliation)}
      </Badge>
    ),
    header: "Reconciliation",
    title: "Event and snapshot agreement",
  },
]

const PRICE_ORACLE_EVENT_COLUMNS = eventColumns({
  hidden: ["chain_id", "currency", "currency_decimals"],
})

function PriceOracle() {
  const labels = useLabels()
  const pages = useCursorPages()
  const { data: routes, error: routesError } = useQuery({
    ...priceOracleQueries.feeds(),
    select: sortRoutes,
  })
  const feeds = routes && groupFeeds(routes)
  const providers = useQuery(priceOracleQueries.providers())
  const {
    data: events,
    error: eventsError,
    isPlaceholderData,
  } = useQuery(priceOracleQueries.events(pages.cursor))
  const routePages = useListPages(routes?.length)
  const origin = (id?: string | null) => labels.originChain(id)

  const routeColumns: Column<PriceFeed>[] = [
    {
      cell: (route) => (
        <TokenLink
          tokenId={route.token_id}
          name={route.name}
          symbol={route.symbol}
        />
      ),
      header: "Token",
      title: "Token name or symbol",
      sortValue: routeLabel,
    },
    {
      cell: (route) => <OriginChain id={route.origin_chain_id} />,
      header: "Chain",
      title: "Origin chain",
      sortValue: (route) => origin(route.origin_chain_id),
    },
    {
      cell: (route) =>
        route.currency_kind === "native" ? (
          "Native"
        ) : route.currency ? (
          <HashText value={route.currency} />
        ) : (
          <Muted />
        ),
      header: "Currency",
      title: "Feed currency",
    },
    {
      cell: (route) => <HashText value={route.feed_id} />,
      header: "Feed ID",
      title: "Price feed identifier",
    },
    {
      cell: (route) => feedStatus([route]),
      header: "Status",
      title: "Route availability and reconciliation",
    },
    {
      align: "right",
      cell: (route) => route.currency_decimals,
      header: "Decimals",
      title: "Currency decimals",
    },
    {
      align: "right",
      cell: (route) => formatSeconds(route.max_age_seconds),
      header: "Expiry",
      title: "Max price age",
    },
    {
      cell: (route) => <StalenessBadge feed={route} />,
      header: "Staleness",
      title: "Oracle price age versus expiry",
      sortValue: stalenessRank,
    },
    {
      align: "right",
      cell: (route) => (
        <RelativeTime value={route.configuration_event?.block_timestamp} />
      ),
      header: "Configured",
      title: "Route configuration time",
      sortValue: (route) => route.configuration_event?.block_number,
    },
    {
      cell: (route) => <TxLink hash={route.configuration_event?.tx_hash} />,
      header: "Transaction",
      title: "Route configuration transaction hash",
    },
  ]

  return (
    <Panel title="Price Oracle">
      <div className="flex flex-col gap-8 bg-subtle p-3 sm:p-4">
        <Card title="Providers">
          <DataTable
            columns={PROVIDER_COLUMNS}
            rows={providers.data?.providers}
            rowKey={(provider) => provider.provider_id}
            empty="No providers configured"
            error={providers.error}
          />
        </Card>
        <Card title="Feeds">
          <DataTable
            columns={FEED_COLUMNS}
            rows={feeds}
            rowKey={(group) => `${group.providerId}:${group.feedId}`}
            defaultSort={{ column: 0, descending: false }}
            empty="No feeds configured"
            error={routesError}
          />
        </Card>
        <Card
          title="Routes"
          actions={
            routePages.last > 1 ? <ListPager pages={routePages} /> : null
          }
        >
          <DataTable
            columns={routeColumns}
            rows={routes}
            page={routePages}
            rowKey={(route) => route.token_id}
            empty="No routes configured"
            error={routesError}
          />
        </Card>
        <Card
          title="Admin Events"
          actions={
            <CursorPager pages={pages} next={events?.pagination.next_cursor} />
          }
        >
          <DataTable
            columns={PRICE_ORACLE_EVENT_COLUMNS}
            rows={events?.events}
            rowKey={eventRowKey}
            empty="No price oracle events"
            pending={isPlaceholderData}
            error={eventsError}
          />
        </Card>
      </div>
    </Panel>
  )
}

type PriceFilter = "all" | "available" | "unavailable" | "oracle"

const PRICE_FILTERS: Array<{ label: string; value: PriceFilter }> = [
  { label: "All", value: "all" },
  { label: "Available", value: "available" },
  { label: "Unavailable", value: "unavailable" },
  { label: "Oracle", value: "oracle" },
]

const isAvailable = (row: Row) => row.resolved.price?.status === "available"

function Tokens({
  rows,
  sources,
  feeds,
  error,
}: {
  rows?: Row[]
  sources?: PriceSourceInfo[]
  feeds?: PriceFeed[]
  error?: Error | null
}) {
  const oracleFeeds = new Map(feeds?.map((feed) => [feed.token_id, feed]))
  const oracleFeed = (row: Row) => oracleFeeds.get(row.asset.token_id)
  const rowDeviation = (row: Row) => {
    const bps = oracleFeed(row)?.deviation_bps
    return bps == null
      ? row.deviation
      : { title: "Oracle versus Relay price", value: bps / 10_000 }
  }
  const filters: Record<PriceFilter, (row: Row) => boolean> = {
    all: () => true,
    available: isAvailable,
    oracle: (row) => oracleFeeds.has(row.asset.token_id),
    unavailable: (row) => !isAvailable(row),
  }
  const search = useSearch()
  const [filter, setFilter] = useState<PriceFilter>("all")
  const query = search.query.toLowerCase()
  const matches = rows?.filter(
    (row) =>
      filters[filter](row) &&
      (!query ||
        row.asset.token_id === query ||
        [row.asset.symbol, row.asset.name].some((value) =>
          value?.toLowerCase().includes(query)
        ))
  )
  const pages = useListPages(matches?.length, `${filter}:${query}`)

  const columns: Column<Row>[] = [
    {
      cell: (row) => (
        <TokenLink
          tokenId={row.asset.token_id}
          name={row.asset.name}
          symbol={row.asset.symbol}
        />
      ),
      header: "Token",
      title: "Token name or symbol",
      sortValue: (row) => assetLabel(row.asset),
    },
    {
      cell: (row) => (
        <HashText value={row.asset.token_id} short={shortTokenId} />
      ),
      header: "ID",
      title: "Hub token ID",
    },
    {
      align: "right",
      cell: (row) =>
        isAvailable(row) && row.resolved.price?.usd_price ? (
          <SourcedPrice
            value={row.resolved.price.usd_price}
            source={row.resolved.price.source}
          />
        ) : (
          <Tooltip
            content={
              row.resolved.price?.error
                ? capitalize(row.resolved.price.error.message)
                : undefined
            }
          >
            <span>
              <Muted />
            </span>
          </Tooltip>
        ),
      header: "Price",
      title: "Resolved token price in USD",
      sortValue: (row) =>
        isAvailable(row) ? Number(row.resolved.price?.usd_price) : undefined,
    },
    {
      cell: (row) => (
        <span className="inline-flex gap-1">
          {sources?.map((source) => {
            const quote = row.quotes[source.id]
            return (
              <Badge
                key={source.id}
                title={quoteTitle(quote)}
                tone={
                  !quote
                    ? "neutral"
                    : quote.status === "unsupported"
                      ? "muted"
                      : PRICE_STATUS_TONES[quote.status]
                }
              >
                {source.id}
              </Badge>
            )
          })}
        </span>
      ),
      header: "Sources",
      title: "Quotes per source",
    },
    {
      cell: (row) => <StalenessBadge feed={oracleFeed(row)} />,
      header: "Staleness",
      title: "Oracle price age versus expiry",
      sortValue: (row) => stalenessRank(oracleFeed(row)),
    },
    {
      cell: (row) => {
        const deviation = rowDeviation(row)
        return deviation ? (
          <DeviationBadge
            value={deviation.value}
            feed={oracleFeed(row)}
            title={deviation.title}
          />
        ) : (
          <Muted />
        )
      },
      header: "Deviation",
      title: "Spread between first two sources",
      sortValue: (row) => {
        const deviation = rowDeviation(row)
        return deviation ? Math.abs(deviation.value) : undefined
      },
    },
    {
      align: "right",
      cell: (row) =>
        isAvailable(row) ? (
          <RelativeTime value={row.resolved.price?.published_at} />
        ) : (
          <Muted />
        ),
      header: "Published",
      title: "Price publish time",
      sortValue: (row) =>
        isAvailable(row) && row.resolved.price?.published_at
          ? Date.parse(row.resolved.price.published_at)
          : undefined,
    },
  ]

  return (
    <Panel
      title="Prices"
      badge={
        rows && matches ? (
          <TitleCount
            label="prices"
            shown={matches.length}
            total={rows.length}
            filtered={filter !== "all" || !!query}
          />
        ) : null
      }
      actions={
        <>
          <SegmentedControl
            label="Price filter"
            options={PRICE_FILTERS}
            value={filter}
            onChange={setFilter}
          />
          <SearchInput placeholder="Search tokens" {...search.input} />
          <ListPager pages={pages} />
        </>
      }
    >
      <DataTable
        columns={columns}
        rows={matches}
        page={pages}
        rowKey={(row) => row.asset.token_id}
        empty="No tokens"
        error={error}
      />
    </Panel>
  )
}

export default function PricesPage() {
  const { data: sources, error } = useQuery({
    ...priceQueries.sources(),
    select: sortSources,
  })
  const { data: rows, error: pricesError } = useQuery({
    ...priceQueries.all(),
    select: priceRows,
  })
  const { data: feeds, error: feedsError } = useQuery(
    priceOracleQueries.feeds()
  )

  return (
    <>
      <FeedCharts feeds={feeds} error={feedsError} />
      <Sources sources={sources} rows={rows} error={error} />
      <Tokens
        rows={rows}
        sources={sources}
        feeds={feeds}
        error={error ?? pricesError}
      />
      <PriceOracle />
    </>
  )
}
