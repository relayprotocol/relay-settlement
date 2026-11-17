import { useId, useState, type ReactNode } from "react"
import type { DepositoryStats, TransferStats } from "../api/schema"
import { cx, formatNumber, plural } from "../utils"
import { Muted, Panel } from "./ui"
import { Usd } from "./Usd"
import { Tooltip } from "./Tooltip"

export const formatTime = (value: string | number) =>
  new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  })

const hourStart = (value: string) => {
  const date = new Date(value)
  date.setUTCMinutes(0, 0, 0)
  return date.toISOString()
}

export const groupHourly = <T extends { start: string }>(buckets: T[]) => {
  const groups = new Map<string, T[]>()
  for (const bucket of buckets) {
    const hour = hourStart(bucket.start)
    groups.set(hour, [...(groups.get(hour) ?? []), bucket])
  }
  return [...groups]
    .filter(
      ([hour, group], index) =>
        index > 0 || Date.parse(group[0]?.start ?? "") === Date.parse(hour)
    )
    .map(([start, group]) => ({ buckets: group, start }))
}

export type ChartStat = { label: string; value?: ReactNode; hint?: string }

export function ChartFooter({
  label,
  stats,
}: {
  label: ReactNode
  stats: ChartStat[]
}) {
  return (
    <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
      <span className="text-fg-muted tabular-nums">{label}</span>
      <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {stats.map((stat) => (
          <Tooltip key={stat.label} content={stat.hint}>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-fg-muted">{stat.label}</dt>
              <dd className="tabular-nums">{stat.value}</dd>
            </div>
          </Tooltip>
        ))}
      </dl>
    </div>
  )
}

export function Pending({ error }: { error?: Error | null }) {
  return <Muted>{error ? "-" : "..."}</Muted>
}

export function BarChart({
  bars,
  selected,
  onSelect,
}: {
  bars?: Array<{ key: string; label: string; value: number }>
  selected?: number
  onSelect: (index?: number) => void
}) {
  const max = Math.max(1, ...(bars ?? []).map((bar) => bar.value))
  return (
    <ol
      className="flex h-24 items-end gap-px sm:gap-0.5"
      onMouseLeave={() => onSelect(undefined)}
    >
      {bars?.map((bar, index) => (
        <li
          key={bar.key}
          tabIndex={0}
          aria-label={bar.label}
          onMouseEnter={() => onSelect(index)}
          onFocus={() => onSelect(index)}
          onBlur={() => onSelect(undefined)}
          className={cx(
            "min-w-0 flex-1 rounded-t-xs bg-chart/80 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-primary",
            selected != null && selected !== index && "opacity-50"
          )}
          style={{ height: `${(bar.value / max) * 100}%` }}
        />
      ))}
    </ol>
  )
}

const WIDTH = 1000
const HEIGHT = 100
const PADDING = 8
const MIN_SPAN = 0.02

const segments = (
  points: Array<number | null>,
  references: Array<number | undefined>,
  fromZero = false
) => {
  const values = [...points, ...references, fromZero ? 0 : null].filter(
    (value): value is number => value != null
  )
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = Math.max(high - low, Math.abs(high) * MIN_SPAN)
  const min = (low + high - span) / 2
  const x = (index: number) =>
    points.length > 1 ? (index / (points.length - 1)) * WIDTH : WIDTH / 2
  const y = (value: number) =>
    span
      ? HEIGHT - PADDING - ((value - min) / span) * (HEIGHT - 2 * PADDING)
      : fromZero
        ? HEIGHT - PADDING
        : HEIGHT / 2
  const runs: Array<Array<[number, number]>> = []
  points.forEach((point, index) => {
    if (point == null) {
      if (runs.at(-1)?.length) runs.push([])
      return
    }
    if (!runs.length) runs.push([])
    runs.at(-1)?.push([x(index), y(point)])
  })
  return { runs: runs.filter((run) => run.length), x, y }
}

const TONES = {
  chart: { fill: "fill-chart/20", stroke: "stroke-chart" },
  error: { fill: "fill-error/20", stroke: "stroke-error" },
} as const

export function LineChart({
  points,
  baseline,
  threshold,
  marker,
  fromZero,
  label,
  selected,
  onSelect,
}: {
  points?: Array<number | null>
  baseline?: number
  threshold?: number
  marker?: string
  fromZero?: boolean
  label: string
  selected?: number
  onSelect: (index?: number) => void
}) {
  const id = useId()
  const count = points?.length ?? 0
  const { runs, x, y } = segments(points ?? [], [baseline, threshold], fromZero)
  const current = selected != null ? points?.[selected] : undefined
  const floor = baseline != null ? y(baseline) : fromZero ? y(0) : HEIGHT
  const level = baseline ?? threshold
  const split = level == null ? undefined : y(level)
  const [upper, lower] =
    threshold == null ? [TONES.chart, TONES.error] : [TONES.error, TONES.chart]
  const sides =
    split == null
      ? [{ ...TONES.chart, clip: undefined, key: "line" }]
      : [
          { ...upper, clip: `url(#${id}-above)`, key: "above" },
          { ...lower, clip: `url(#${id}-below)`, key: "below" },
        ]
  const alarm =
    current != null &&
    (baseline != null
      ? current < baseline
      : threshold != null && current > threshold)
  const select = (fraction: number) =>
    onSelect(
      count
        ? Math.min(count - 1, Math.max(0, Math.round(fraction * (count - 1))))
        : undefined
    )
  return (
    <div
      role="img"
      aria-label={label}
      tabIndex={0}
      className="relative h-24 outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onPointerMove={(event) => {
        const { left, width } = event.currentTarget.getBoundingClientRect()
        if (width) select((event.clientX - left) / width)
      }}
      onPointerLeave={() => onSelect(undefined)}
      onKeyDown={(event) => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
        if (!step || !count) return
        event.preventDefault()
        onSelect(
          Math.min(count - 1, Math.max(0, (selected ?? count - 1) + step))
        )
      }}
      onBlur={() => onSelect(undefined)}
    >
      <svg
        aria-hidden
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="size-full overflow-visible"
      >
        {split == null ? null : (
          <>
            <defs>
              <clipPath id={`${id}-above`}>
                <rect x={0} y={-HEIGHT} width={WIDTH} height={HEIGHT + split} />
              </clipPath>
              <clipPath id={`${id}-below`}>
                <rect x={0} y={split} width={WIDTH} height={2 * HEIGHT} />
              </clipPath>
            </defs>
            <line
              x1={0}
              y1={split}
              x2={WIDTH}
              y2={split}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="4 4"
              className="stroke-fg-muted/50"
            />
          </>
        )}
        {runs.map((run) => {
          const line = run
            .map(([px, py], index) => `${index ? "L" : "M"}${px} ${py}`)
            .join(" ")
          const [first] = run
          const last = run.at(-1)
          return sides.map((side) => (
            <g key={`${first?.[0]}-${side.key}`} clipPath={side.clip}>
              <path
                d={`${line} L${last?.[0]} ${floor} L${first?.[0]} ${floor} Z`}
                className={side.fill}
              />
              <path
                d={line}
                fill="none"
                vectorEffect="non-scaling-stroke"
                className={cx(side.stroke, "stroke-2")}
              />
            </g>
          ))
        })}
      </svg>
      {split != null && marker ? (
        <span
          aria-hidden
          className={cx(
            "pointer-events-none absolute left-0 rounded-sm bg-surface/80 px-1 text-[10px] leading-4 text-fg-subtle",
            split < HEIGHT / 2 ? "mt-0.5" : "-mt-0.5 -translate-y-full"
          )}
          style={{ top: `${(split / HEIGHT) * 100}%` }}
        >
          {marker}
        </span>
      ) : null}
      {selected != null && count > 1 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-fg-muted/50"
          style={{ left: `${(x(selected) / WIDTH) * 100}%` }}
        >
          {current != null ? (
            <span
              className={cx(
                "absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface",
                alarm ? "bg-error" : "bg-chart"
              )}
              style={{ top: `${(y(current) / HEIGHT) * 100}%` }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function BalancePanel({
  title,
  stats,
  error,
  actions,
}: {
  title: string
  stats?: TransferStats | DepositoryStats | null
  error?: Error | null
  actions?: ReactNode
}) {
  const [selected, setSelected] = useState<number>()
  const points = stats?.buckets.map((bucket) => bucket.balance_usd ?? null)
  const index = selected ?? (points ? points.length - 1 : undefined)
  const bucket = index == null ? undefined : stats?.buckets[index]
  const value = bucket?.balance_usd
  const end = bucket
    ? Date.parse(bucket.start) + (stats?.bucket_minutes ?? 0) * 60_000
    : undefined
  return (
    <Panel title={title} actions={actions}>
      <div className="px-4 pt-3 pb-2">
        <LineChart
          points={points}
          label={`${title} over the last 24 hours`}
          selected={selected}
          onSelect={setSelected}
        />
        <ChartFooter
          label={selected != null && end ? formatTime(end) : "Last 24 hours"}
          stats={[
            {
              label: "Priced",
              hint: stats
                ? `${plural(stats.tokens.priced, "asset")} included in balance`
                : undefined,
              value: stats ? (
                formatNumber(stats.tokens.priced)
              ) : stats === null ? (
                <Muted>-</Muted>
              ) : (
                <Pending error={error} />
              ),
            },
            {
              label: "Excluded",
              hint: stats
                ? `${plural(stats.excluded.length, "asset")} excluded from balance`
                : undefined,
              value: stats ? (
                formatNumber(stats.excluded.length)
              ) : stats === null ? (
                <Muted>-</Muted>
              ) : (
                <Pending error={error} />
              ),
            },
            {
              label: title,
              value:
                value != null ? (
                  <Usd value={value} />
                ) : stats && value === null ? (
                  "-"
                ) : stats === null ? (
                  <Muted>-</Muted>
                ) : (
                  <Pending error={error} />
                ),
            },
          ]}
        />
      </div>
    </Panel>
  )
}
