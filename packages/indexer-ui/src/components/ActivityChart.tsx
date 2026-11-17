import {
  useQuery,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query"
import { useState } from "react"
import { DAY_WINDOW, type StatsWindow } from "../api/queries"
import { formatNumber, formatUsd } from "../utils"
import {
  BarChart,
  ChartFooter,
  Pending,
  formatTime,
  groupHourly,
} from "./charts"
import { Muted, Panel, SegmentedControl } from "./ui"

type Measure = "count" | "volume"

export type ActivityMeasures<T> = Record<
  Measure,
  {
    total: (counts: T) => number
    series: Array<{ label: string; value: (counts: T) => number }>
  }
>

const FORMATS: Record<Measure, (value: number) => string> = {
  count: formatNumber,
  volume: formatUsd,
}

const MEASURE_OPTIONS: Array<{ label: string; value: Measure }> = [
  { label: "Actions", value: "count" },
  { label: "Volume", value: "volume" },
]

const formatDay = (value: string, timeZone?: string) =>
  new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  })

type Range = "24h" | "7d" | "30d"

const RANGES: Record<
  Range,
  { format: (start: string) => string; label: string; window: StatsWindow }
> = {
  "24h": { format: formatTime, label: "Last 24 hours", window: DAY_WINDOW },
  "7d": {
    format: (start) => `${formatDay(start)} ${formatTime(start)}`,
    label: "Last 7 days",
    window: { bucketMinutes: 360, hours: 168 },
  },
  "30d": {
    format: (start) => formatDay(start, "UTC"),
    label: "Last 30 days",
    window: { bucketMinutes: 1440, hours: 720 },
  },
}

const RANGE_OPTIONS: Array<{ label: string; value: Range }> = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
]

export function ActivityChart<
  T,
  S extends { buckets: Array<T & { start: string }> },
  K extends QueryKey,
>({
  title,
  measures,
  sum,
  query,
  enabled = true,
}: {
  title: string
  enabled?: boolean
  measures: ActivityMeasures<T>
  sum: (buckets: T[]) => T
  query: (window: StatsWindow) => UseQueryOptions<S, Error, S, K>
}) {
  const [selected, setSelected] = useState<number>()
  const [measure, setMeasure] = useState<Measure>("count")
  const [range, setRange] = useState<Range>("24h")
  const scale = RANGES[range]
  const { data, error, isPlaceholderData } = useQuery({
    ...query(scale.window),
    ...(!enabled && { enabled: false }),
  })
  const stats = !enabled || isPlaceholderData ? undefined : data
  const bars = stats
    ? groupHourly(stats.buckets).map(({ buckets, start }) => ({
        counts: sum(buckets),
        start,
      }))
    : undefined
  const format = FORMATS[measure]
  const { series, total } = measures[measure]
  const current = selected == null ? undefined : bars?.[selected]
  const counts = current?.counts ?? (stats && sum(stats.buckets))
  return (
    <Panel
      title={title}
      actions={
        <>
          <SegmentedControl
            label={`${title} range`}
            options={RANGE_OPTIONS}
            value={range}
            onChange={(next) => {
              setRange(next)
              setSelected(undefined)
            }}
          />
          <SegmentedControl
            label={`${title} measure`}
            options={MEASURE_OPTIONS}
            value={measure}
            onChange={setMeasure}
          />
        </>
      }
    >
      <div className="px-4 pt-3 pb-2">
        <BarChart
          bars={bars?.map((bar) => ({
            key: bar.start,
            label: `${scale.format(bar.start)}: ${format(total(bar.counts))}`,
            value: total(bar.counts),
          }))}
          selected={selected}
          onSelect={setSelected}
        />
        <ChartFooter
          label={current ? scale.format(current.start) : scale.label}
          stats={series.map((item) => ({
            label: item.label,
            value: !enabled ? (
              <Muted>-</Muted>
            ) : counts ? (
              format(item.value(counts))
            ) : (
              <Pending error={error} />
            ),
          }))}
        />
      </div>
    </Panel>
  )
}
