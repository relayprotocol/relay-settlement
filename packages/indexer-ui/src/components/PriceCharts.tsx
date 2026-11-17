import { useQuery } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { priceOracleQueries } from "../api/queries"
import type {
  PriceFeed,
  PriceFeedStats,
  PriceFeedStatsBucket,
} from "../api/schema"
import { useTokens } from "../tokens"
import { displayTokenLabel, formatDeviation, formatDuration } from "../utils"
import {
  ChartFooter,
  LineChart,
  Pending,
  formatTime,
  type ChartStat,
} from "./charts"
import { OriginChainIcon } from "./links"
import { Picker, type PickerOption } from "./Picker"
import { feedAlert } from "./status"
import { Muted, Panel } from "./ui"

type Series = {
  title: string
  value: (bucket: PriceFeedStatsBucket) => number | null
  format: (value: number) => string
  baseline?: number
  threshold?: (stats: PriceFeedStats) => number | undefined
  marker: (level: number) => string
  labels: { current: string; extreme: string }
  hints: { current: string; extreme: string }
  extreme: (values: number[]) => number
  extra?: (stats: PriceFeedStats) => ChartStat
}

const formatSeconds = (seconds: number) => formatDuration(seconds * 1000)

const DEVIATION: Series = {
  title: "Deviation",
  baseline: 0,
  extreme: (values) =>
    values.reduce((worst, value) =>
      Math.abs(value) > Math.abs(worst) ? value : worst
    ),
  format: formatDeviation,
  marker: formatDeviation,
  hints: {
    current: "Oracle price minus Relay price",
    extreme: "Largest deviation in window",
  },
  labels: { current: "Deviation", extreme: "Worst" },
  value: (bucket) =>
    bucket.deviation_bps == null ? null : bucket.deviation_bps / 10_000,
}

const STALENESS: Series = {
  title: "Staleness",
  extra: (stats) => ({
    hint: "Max price age",
    label: "Expiry",
    value:
      stats.expiry_sec == null ? <Muted /> : formatSeconds(stats.expiry_sec),
  }),
  extreme: (values) => Math.max(...values),
  format: formatSeconds,
  marker: (level) => formatSeconds(level).replace(" ", ""),
  threshold: (stats) => stats.expiry_sec ?? undefined,
  hints: {
    current: "Time since the publish time",
    extreme: "Oldest price in window",
  },
  labels: { current: "Age", extreme: "Max" },
  value: (bucket) => bucket.staleness_sec ?? null,
}

const lastValue = (points?: Array<number | null>) =>
  points?.findLast((point) => point != null) ?? undefined

const alertRank = (feed: PriceFeed) =>
  feedAlert(feed, "price_stale")
    ? 2
    : feedAlert(feed, "price_deviation")
      ? 1
      : 0

const alertedFeed = (feeds?: PriceFeed[]) =>
  feeds
    ?.filter((feed) => alertRank(feed) > 0)
    .toSorted(
      (a, b) =>
        alertRank(b) - alertRank(a) ||
        Math.abs(b.deviation_bps ?? 0) - Math.abs(a.deviation_bps ?? 0)
    )[0]

function FeedChart({
  series: { title, ...series },
  stats,
  error,
  empty,
  selected,
  onSelect,
  actions,
}: {
  series: Series
  stats?: PriceFeedStats
  error?: Error | null
  empty: boolean
  selected?: number
  onSelect: (index?: number) => void
  actions?: ReactNode
}) {
  const points = stats?.buckets.map(series.value)
  const values = points?.filter((point): point is number => point != null)
  const bucket = selected == null ? undefined : stats?.buckets[selected]
  const current =
    selected == null ? lastValue(points) : (points?.[selected] ?? undefined)
  const end = bucket
    ? Date.parse(bucket.start) + (stats?.bucket_minutes ?? 0) * 60_000
    : undefined
  const threshold = stats && series.threshold?.(stats)
  const level = series.baseline ?? threshold
  const loaded = !!values || empty
  const pending = (value?: number) =>
    value != null ? (
      series.format(value)
    ) : loaded ? (
      <Muted />
    ) : (
      <Pending error={error} />
    )
  return (
    <Panel
      title={title}
      actions={actions ?? <span aria-hidden className="h-6.5" />}
    >
      <div className="px-4 pt-3 pb-2">
        <LineChart
          points={points}
          baseline={series.baseline}
          threshold={threshold}
          marker={level == null ? undefined : series.marker(level)}
          label={`${title} over the last 24 hours`}
          selected={selected}
          onSelect={onSelect}
        />
        <ChartFooter
          label={selected != null && end ? formatTime(end) : "Last 24 hours"}
          stats={[
            {
              hint: series.hints.current,
              label: series.labels.current,
              value:
                threshold != null && current != null && current > threshold ? (
                  <span className="text-error-fg">{pending(current)}</span>
                ) : (
                  pending(current)
                ),
            },
            {
              hint: series.hints.extreme,
              label: series.labels.extreme,
              value: pending(
                values?.length ? series.extreme(values) : undefined
              ),
            },
            ...(series.extra && stats ? [series.extra(stats)] : []),
          ]}
        />
      </div>
    </Panel>
  )
}

export function FeedCharts({
  feeds,
  error,
}: {
  feeds?: PriceFeed[]
  error?: Error | null
}) {
  const tokens = useTokens()
  const [choice, setChoice] = useState("")
  const [selected, setSelected] = useState<number>()
  const options = feeds
    ?.map(
      (feed): PickerOption => ({
        hint: tokens?.get(feed.token_id)?.origin_asset ?? feed.token_id,
        icon: (
          <OriginChainIcon id={tokens?.get(feed.token_id)?.origin_chain_id} />
        ),
        id: feed.token_id,
        name: displayTokenLabel(feed.name, feed.symbol),
      })
    )
    .toSorted((a, b) => a.name.localeCompare(b.name))
  const token = options?.some((option) => option.id === choice)
    ? choice
    : (alertedFeed(feeds)?.token_id ?? options?.[0]?.id ?? "")
  const stats = useQuery({
    ...priceOracleQueries.feedStats(token),
    enabled: token !== "",
  })
  const chart = {
    empty: !!options && !options.length,
    error: error ?? stats.error,
    onSelect: setSelected,
    selected,
    stats: stats.data,
  }
  return (
    <>
      <FeedChart
        series={STALENESS}
        actions={
          <Picker
            noun="token"
            options={options ?? []}
            value={token}
            label="Select token"
            onChange={setChoice}
            variant="field"
            align="end"
            className="w-48"
          />
        }
        {...chart}
      />
      <FeedChart series={DEVIATION} {...chart} />
    </>
  )
}
