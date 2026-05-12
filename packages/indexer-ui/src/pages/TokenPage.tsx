import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  Balance,
  Event,
  Token,
  fetchEvents,
  fetchToken,
  fetchTokenBalances,
  fetchTokenTransferStats,
  TransferStat,
} from "../api"
import {
  displayTokenLabel,
  displayTokenName,
  formatAmount,
  formatTimestamp,
  displayAddress,
  shortHash,
  txUrl,
  ZERO_ADDRESS,
} from "../utils"

export default function TokenPage() {
  const { id } = useParams()
  const tokenId = id ?? ""
  const [token, setToken] = useState<Token | null>(null)
  const [balances, setBalances] = useState<Balance[]>([])
  const [balancesCursor, setBalancesCursor] = useState<string | null>(null)
  const [balancesCursorStack, setBalancesCursorStack] = useState<string[]>([])
  const [balancesNextCursor, setBalancesNextCursor] = useState<string | null>(
    null
  )
  const [events, setEvents] = useState<Event[]>([])
  const [eventsCursor, setEventsCursor] = useState<string | null>(null)
  const [eventsCursorStack, setEventsCursorStack] = useState<string[]>([])
  const [eventsNextCursor, setEventsNextCursor] = useState<string | null>(null)
  const [hasTransfers, setHasTransfers] = useState<boolean>(false)
  const [transferStats, setTransferStats] = useState<TransferStat[]>([])
  const [granularity, setGranularity] = useState<string>("day")
  const [statsError, setStatsError] = useState<string>("")
  const [error, setError] = useState<string>("")

  const EVENTS_PER_PAGE = 20
  const eventsPage = eventsCursorStack.length + 1

  const tokenName = useMemo(() => displayTokenName(token?.name), [token])
  const tokenSymbol = useMemo(
    () => displayTokenLabel(token?.name, token?.symbol),
    [token]
  )

  useEffect(() => {
    setEventsCursor(null)
    setEventsCursorStack([])
    setEventsNextCursor(null)
    setHasTransfers(false)
    setBalancesCursor(null)
    setBalancesCursorStack([])
    setBalancesNextCursor(null)
  }, [tokenId])

  const loadToken = async () => {
    if (!tokenId) return
    try {
      const data = await fetchToken(tokenId)
      setToken(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load token")
    }
  }

  const loadBalances = async () => {
    if (!tokenId) return
    try {
      const data = await fetchTokenBalances(
        tokenId,
        100,
        balancesCursor ?? undefined
      )
      setBalances(data.data)
      setBalancesNextCursor(data.nextCursor ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load balances")
    }
  }

  const loadEvents = async () => {
    if (!tokenId) return
    try {
      const data = await fetchEvents(
        tokenId,
        undefined,
        EVENTS_PER_PAGE,
        eventsCursor ?? undefined
      )
      setEvents(data.data)
      setEventsNextCursor(data.nextCursor ?? null)
      if (!eventsCursor) {
        setHasTransfers(data.data.length > 0)
      } else if (data.data.length) {
        setHasTransfers(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load transfers")
    }
  }

  const loadTransferStats = async () => {
    if (!tokenId) return
    try {
      const points =
        granularity === "minute"
          ? 60
          : granularity === "hour"
            ? 24
            : granularity === "week"
              ? 12
              : granularity === "month"
                ? 12
                : 30
      const data = await fetchTokenTransferStats(
        tokenId,
        granularity,
        points,
        tzOffsetMinutes
      )
      setTransferStats(data.data)
      setStatsError("")
    } catch (err) {
      setTransferStats([])
      setStatsError(
        err instanceof Error ? err.message : "Failed to load transfer stats"
      )
    }
  }

  useEffect(() => {
    void loadToken()
    void loadBalances()
    void loadEvents()
    void loadTransferStats()
    const interval = setInterval(() => {
      void loadToken()
      void loadBalances()
      void loadEvents()
      void loadTransferStats()
    }, 5000)
    return () => clearInterval(interval)
  }, [tokenId, eventsCursor, balancesCursor, granularity])

  const tzOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), [])
  const chartSeries = useMemo(() => {
    const points =
      granularity === "minute"
        ? 60
        : granularity === "hour"
          ? 24
          : granularity === "week"
            ? 12
            : granularity === "month"
              ? 12
              : 30
    const now = new Date()
    const map = new Map(transferStats.map((item) => [item.bucket, item.count]))
    const series: Array<{ bucket: string; count: number }> = []
    const pad = (value: number) => String(value).padStart(2, "0")
    const getBucket = (date: Date) => {
      const year = date.getFullYear()
      const month = pad(date.getMonth() + 1)
      const day = pad(date.getDate())
      const hour = pad(date.getHours())
      const minute = pad(date.getMinutes())
      if (granularity === "minute") {
        return `${year}-${month}-${day} ${hour}:${minute}`
      }
      if (granularity === "hour") {
        return `${year}-${month}-${day} ${hour}:00`
      }
      if (granularity === "week") {
        const dayOfWeek = (date.getDay() + 6) % 7
        const monday = new Date(date)
        monday.setDate(date.getDate() - dayOfWeek)
        return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(
          monday.getDate()
        )}`
      }
      if (granularity === "month") {
        return `${year}-${month}`
      }
      return `${year}-${month}-${day}`
    }

    const base = new Date(now)
    if (granularity === "minute") {
      base.setSeconds(0, 0)
    } else if (granularity === "hour") {
      base.setMinutes(0, 0, 0)
    } else if (granularity === "day") {
      base.setHours(0, 0, 0, 0)
    } else if (granularity === "week") {
      base.setHours(0, 0, 0, 0)
      const dayOfWeek = (base.getDay() + 6) % 7
      base.setDate(base.getDate() - dayOfWeek)
    } else if (granularity === "month") {
      base.setHours(0, 0, 0, 0)
      base.setDate(1)
    }

    for (let i = points - 1; i >= 0; i -= 1) {
      const date = new Date(base)
      if (granularity === "minute") {
        date.setMinutes(date.getMinutes() - i)
      } else if (granularity === "hour") {
        date.setHours(date.getHours() - i)
      } else if (granularity === "week") {
        date.setDate(date.getDate() - i * 7)
      } else if (granularity === "month") {
        date.setMonth(date.getMonth() - i)
      } else {
        date.setDate(date.getDate() - i)
      }
      const bucket = getBucket(date)
      series.push({ bucket, count: map.get(bucket) ?? 0 })
    }
    return series
  }, [transferStats, granularity])

  const maxCount = useMemo(
    () => Math.max(1, ...chartSeries.map((item) => item.count)),
    [chartSeries]
  )
  const formatBucket = (bucket: string) => {
    if (granularity === "month") {
      return new Date(`${bucket}-01T00:00:00`).toLocaleDateString("en-US")
    }
    if (granularity === "week") {
      return new Date(`${bucket}T00:00:00`).toLocaleDateString("en-US")
    }
    if (granularity === "day") {
      return new Date(`${bucket}T00:00:00`).toLocaleDateString("en-US")
    }
    if (granularity === "hour") {
      return new Date(bucket.replace(" ", "T") + ":00").toLocaleString(
        "en-US",
        {
          hour12: false,
        }
      )
    }
    return new Date(bucket.replace(" ", "T")).toLocaleString("en-US", {
      hour12: false,
    })
  }

  const hasNonZeroBalances = balances.length > 0

  const handleEventsNext = () => {
    if (!eventsNextCursor) return
    setEventsCursorStack((prev) => [...prev, eventsCursor ?? ""])
    setEventsCursor(eventsNextCursor)
  }

  const handleEventsPrev = () => {
    setEventsCursorStack((prev) => {
      if (!prev.length) return prev
      const next = [...prev]
      const cursor = next.pop() ?? null
      setEventsCursor(cursor || null)
      return next
    })
  }

  const handleBalancesNext = () => {
    if (!balancesNextCursor) return
    setBalancesCursorStack((prev) => [...prev, balancesCursor ?? ""])
    setBalancesCursor(balancesNextCursor)
  }

  const handleBalancesPrev = () => {
    setBalancesCursorStack((prev) => {
      if (!prev.length) return prev
      const next = [...prev]
      const cursor = next.pop() ?? null
      setBalancesCursor(cursor || null)
      return next
    })
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Token detail</p>
          <h1>{tokenName}</h1>
          <p className="muted">
            <Link className="token-link" to="/">
              Back to overview
            </Link>
          </p>
        </div>
      </header>

      {error ? <div className="banner">{error}</div> : null}

      <section className="panel">
        <div className="stat single">
          <div className="token-lines">
            <p className="value token-name">{tokenName}</p>
            <div className="stat-row">
              <div>
                <p className="label">Total supply</p>
                <p className="value">
                  {token
                    ? formatAmount(token.total_supply, token.decimals)
                    : "-"}
                </p>
              </div>
              <div>
                <p className="label">Holders</p>
                <p className="value">
                  {token?.holders?.toLocaleString("en-US") ?? "-"}
                </p>
              </div>
              <div>
                <p className="label">Decimals</p>
                <p className="value">{token?.decimals ?? "-"}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {hasTransfers ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Transfers over time</h2>
            <div className="panel-actions">
              <div className="chart-controls">
                <label className="muted">Granularity</label>
                <select
                  value={granularity}
                  onChange={(event) => setGranularity(event.target.value)}
                >
                  <option value="minute">Minutely</option>
                  <option value="hour">Hourly</option>
                  <option value="day">Daily</option>
                  <option value="week">Weekly</option>
                  <option value="month">Monthly</option>
                </select>
              </div>
            </div>
          </div>
          {statsError ? (
            <div className="empty">Transfer chart unavailable.</div>
          ) : (
            <div
              className="sparkline"
              style={{
                gridTemplateColumns: `repeat(${chartSeries.length}, minmax(0, 1fr))`,
              }}
            >
              {chartSeries.map((item) => (
                <div
                  key={item.bucket}
                  className="sparkbar"
                  data-tooltip={`${item.count} transfers on ${formatBucket(item.bucket)}`}
                >
                  <div
                    className="sparkfill"
                    style={{ height: `${(item.count / maxCount) * 100}%` }}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {hasTransfers && hasNonZeroBalances ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Top holders</h2>
            <div className="panel-actions">
              <div className="pager">
                <button
                  className="btn ghost"
                  disabled={!balancesCursorStack.length}
                  onClick={handleBalancesPrev}
                >
                  Prev
                </button>
                <span className="muted">
                  Page {balancesCursorStack.length + 1}
                </span>
                <button
                  className="btn ghost"
                  disabled={!balancesNextCursor}
                  onClick={handleBalancesNext}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
          <div className="table two-col">
            <div className="table-row header">
              <span>Address</span>
              <span>Balance</span>
            </div>
            {balances.map((balance) => (
              <div key={balance.address} className="table-row">
                <span>
                  <Link
                    className="token-link"
                    to={`/address/${balance.address}`}
                  >
                    {displayAddress(balance.address)}
                  </Link>
                </span>
                <span>{formatAmount(balance.balance, token?.decimals)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {hasTransfers ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Recent transfers</h2>
            <div className="panel-actions">
              <div className="pager">
                <button
                  className="btn ghost"
                  disabled={!eventsCursorStack.length}
                  onClick={handleEventsPrev}
                >
                  Prev
                </button>
                <span className="muted">Page {eventsPage}</span>
                <button
                  className="btn ghost"
                  disabled={!eventsNextCursor}
                  onClick={handleEventsNext}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
          <div className="table five-col">
            <div className="table-row header">
              <span>Time</span>
              <span>Tx</span>
              <span>From</span>
              <span>To</span>
              <span>Amount</span>
              <span>Type</span>
            </div>
            {events.map((event) => (
              <div
                key={`${event.tx_hash}-${event.log_index}`}
                className="table-row"
              >
                <span className="time-cell">
                  <span>{formatTimestamp(event.timestamp)}</span>
                  <span className="row-token-name">{tokenSymbol}</span>
                </span>
                <span>
                  <a
                    href={txUrl(event.tx_hash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortHash(event.tx_hash)}
                  </a>
                </span>
                <span>
                  <Link
                    className="token-link"
                    to={`/address/${event.from_addr}`}
                  >
                    {displayAddress(event.from_addr)}
                  </Link>
                </span>
                <span>
                  <Link className="token-link" to={`/address/${event.to_addr}`}>
                    {displayAddress(event.to_addr)}
                  </Link>
                </span>
                <span className="amount-cell">
                  {formatAmount(event.amount, token?.decimals)}
                </span>
                <span className="type-cell">
                  {event.from_addr === ZERO_ADDRESS
                    ? "Mint"
                    : event.to_addr === ZERO_ADDRESS
                      ? "Burn"
                      : "Transfer"}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
