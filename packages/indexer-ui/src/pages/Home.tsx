import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import {
  Event,
  Holder,
  RoleConfig,
  Token,
  fetchEvents,
  fetchGlobalTransferStats,
  fetchConfig,
  fetchHolders,
  fetchRoleConfig,
  fetchToken,
  fetchTokens,
  TransferStat,
} from "../api"
import {
  displayTokenLabel,
  displayTokenName,
  formatAmount,
  formatTimestamp,
  displayAddress,
  displayRole,
  shortHash,
  shortTokenId,
  tokenPath,
  txUrl,
  ZERO_ADDRESS,
} from "../utils"

export default function Home() {
  const [tokens, setTokens] = useState<Token[]>([])
  const [tokenCursor, setTokenCursor] = useState<string | null>(null)
  const [tokenCursorStack, setTokenCursorStack] = useState<string[]>([])
  const [tokenNextCursor, setTokenNextCursor] = useState<string | null>(null)
  const [tokenSearch, setTokenSearch] = useState<string>("")
  const [events, setEvents] = useState<Event[]>([])
  const [eventsCursor, setEventsCursor] = useState<string | null>(null)
  const [eventsCursorStack, setEventsCursorStack] = useState<string[]>([])
  const [eventsNextCursor, setEventsNextCursor] = useState<string | null>(null)
  const [transferStats, setTransferStats] = useState<TransferStat[]>([])
  const [granularity, setGranularity] = useState<string>("day")
  const [statsError, setStatsError] = useState<string>("")
  const [holders, setHolders] = useState<Holder[]>([])
  const [holdersCursor, setHoldersCursor] = useState<string | null>(null)
  const [holdersCursorStack, setHoldersCursorStack] = useState<string[]>([])
  const [holdersNextCursor, setHoldersNextCursor] = useState<string | null>(
    null
  )
  const [holdersError, setHoldersError] = useState<string>("")
  const [roleConfig, setRoleConfig] = useState<RoleConfig[]>([])
  const [roleConfigError, setRoleConfigError] = useState<string>("")
  const [configAddress, setConfigAddress] = useState<string>("")
  const [configError, setConfigError] = useState<string>("")
  const [error, setError] = useState<string>("")
  const [tokenDetails, setTokenDetails] = useState<Record<string, Token>>({})

  const TOKENS_PER_PAGE = 20
  const EVENTS_PER_PAGE = 20
  const HOLDERS_PER_PAGE = 30
  const tzOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), [])

  const tokenById = useMemo(
    () => new Map(Object.entries(tokenDetails)),
    [tokenDetails]
  )

  const loadTokenDetails = async (tokenIds: string[]) => {
    const missing = tokenIds.filter((id) => !tokenDetails[id])
    if (!missing.length) return
    try {
      const results = await Promise.all(
        missing.map((id) => fetchToken(id).catch(() => null))
      )
      const next: Record<string, Token> = {}
      for (const token of results) {
        if (token) {
          next[token.token_id] = token
        }
      }
      if (Object.keys(next).length) {
        setTokenDetails((prev) => ({ ...prev, ...next }))
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load token details"
      )
    }
  }

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

  const loadTokens = async () => {
    try {
      const data = await fetchTokens(
        TOKENS_PER_PAGE,
        tokenCursor ?? undefined,
        tokenSearch.trim() || undefined
      )
      setTokens(data.data)
      setTokenNextCursor(data.nextCursor ?? null)
      const mapped: Record<string, Token> = {}
      data.data.forEach((token) => {
        mapped[token.token_id] = token
      })
      setTokenDetails((prev) => ({ ...prev, ...mapped }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tokens")
    }
  }

  const loadEvents = async () => {
    try {
      const tokenEvents = await fetchEvents(
        undefined,
        undefined,
        EVENTS_PER_PAGE,
        eventsCursor ?? undefined
      )
      setEvents(tokenEvents.data)
      setEventsNextCursor(tokenEvents.nextCursor ?? null)
      await loadTokenDetails(
        Array.from(new Set(tokenEvents.data.map((event) => event.token_id)))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events")
    }
  }

  const loadTransferStats = async () => {
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
      const data = await fetchGlobalTransferStats(
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

  const loadHolders = async () => {
    try {
      const data = await fetchHolders(
        HOLDERS_PER_PAGE,
        holdersCursor ?? undefined
      )
      setHolders(data.data)
      setHoldersNextCursor(data.nextCursor ?? null)
      setHoldersError("")
    } catch (err) {
      setHolders([])
      setHoldersError(
        err instanceof Error ? err.message : "Failed to load holders"
      )
    }
  }

  const loadRoleConfig = async () => {
    if (!configAddress) {
      return
    }
    try {
      const data = await fetchRoleConfig(configAddress)
      setRoleConfig(data.data)
      setRoleConfigError("")
    } catch (err) {
      setRoleConfig([])
      setRoleConfigError(
        err instanceof Error ? err.message : "Failed to load roles"
      )
    }
  }

  const loadConfig = async () => {
    try {
      const data = await fetchConfig()
      setConfigAddress(data.contractAddress ?? "")
      setConfigError("")
    } catch (err) {
      setConfigAddress("")
      setConfigError(
        err instanceof Error ? err.message : "Failed to load config"
      )
    }
  }

  useEffect(() => {
    void loadTokens()
    void loadEvents()
    void loadTransferStats()
    void loadHolders()
    const interval = setInterval(() => {
      void loadTokens()
      void loadEvents()
      void loadTransferStats()
      void loadHolders()
    }, 5000)
    return () => clearInterval(interval)
  }, [eventsCursor, tokenCursor, granularity, holdersCursor, tokenSearch])

  useEffect(() => {
    void loadConfig()
    const interval = setInterval(() => {
      void loadConfig()
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    void loadRoleConfig()
    const interval = setInterval(() => {
      void loadRoleConfig()
    }, 5000)
    return () => clearInterval(interval)
  }, [configAddress])

  const handleTokensNext = () => {
    if (!tokenNextCursor) return
    setTokenCursorStack((prev) => [...prev, tokenCursor ?? ""])
    setTokenCursor(tokenNextCursor)
  }

  const handleTokensPrev = () => {
    setTokenCursorStack((prev) => {
      if (!prev.length) return prev
      const next = [...prev]
      const cursor = next.pop() ?? null
      setTokenCursor(cursor || null)
      return next
    })
  }

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

  const handleHoldersNext = () => {
    if (!holdersNextCursor) return
    setHoldersCursorStack((prev) => [...prev, holdersCursor ?? ""])
    setHoldersCursor(holdersNextCursor)
  }

  const handleHoldersPrev = () => {
    setHoldersCursorStack((prev) => {
      if (!prev.length) return prev
      const next = [...prev]
      const cursor = next.pop() ?? null
      setHoldersCursor(cursor || null)
      return next
    })
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <h1>Relay Settlement Indexer</h1>
        </div>
        <button className="btn" onClick={loadTokens}>
          Refresh
        </button>
      </header>

      {error ? <div className="banner">{error}</div> : null}

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

      <section className="panel">
        <div className="panel-header">
          <h2>Tokens</h2>
          <div className="panel-actions row">
            <input
              className="search-input"
              placeholder="Search by name"
              value={tokenSearch}
              onChange={(event) => {
                setTokenCursor(null)
                setTokenCursorStack([])
                setTokenNextCursor(null)
                setTokenSearch(event.target.value)
              }}
            />
            <div className="pager">
              <button
                className="btn ghost"
                disabled={!tokenCursorStack.length}
                onClick={handleTokensPrev}
              >
                Prev
              </button>
              <span className="muted">Page {tokenCursorStack.length + 1}</span>
              <button
                className="btn ghost"
                disabled={!tokenNextCursor}
                onClick={handleTokensNext}
              >
                Next
              </button>
            </div>
          </div>
        </div>
        <div className="table tokens-table">
          <div className="table-row header">
            <span>Token</span>
            <span>Transfers</span>
            <span>Holders</span>
            <span>Total supply</span>
          </div>
          {tokens.map((token) => (
            <div key={token.token_id} className="table-row">
              <span>
                <Link className="token-link" to={tokenPath(token.token_id)}>
                  <strong>{displayTokenName(token.name)}</strong>
                </Link>
                <span className="muted"> #{shortTokenId(token.token_id)}</span>
              </span>
              <span>{token.transfers.toLocaleString("en-US")}</span>
              <span>{token.holders.toLocaleString("en-US")}</span>
              <span>{formatAmount(token.total_supply, token.decimals)}</span>
            </div>
          ))}
          {!tokens.length ? (
            <div className="empty">No tokens indexed yet.</div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>All holders</h2>
          <div className="panel-actions">
            <div className="pager">
              <button
                className="btn ghost"
                disabled={!holdersCursorStack.length}
                onClick={handleHoldersPrev}
              >
                Prev
              </button>
              <span className="muted">
                Page {holdersCursorStack.length + 1}
              </span>
              <button
                className="btn ghost"
                disabled={!holdersNextCursor}
                onClick={handleHoldersNext}
              >
                Next
              </button>
            </div>
          </div>
        </div>
        <div className="table two-col">
          <div className="table-row header">
            <span>Address</span>
            <span>Last transfer</span>
          </div>
          {holders.map((holder) => (
            <div key={holder.address} className="table-row">
              <span>
                <Link className="token-link" to={`/address/${holder.address}`}>
                  {displayAddress(holder.address)}
                </Link>
              </span>
              <span>
                {holder.last_transfer_timestamp != null
                  ? formatTimestamp(holder.last_transfer_timestamp)
                  : "-"}
              </span>
            </div>
          ))}
          {holdersError ? <div className="empty">{holdersError}</div> : null}
          {!holders.length && !holdersError ? (
            <div className="empty">No holders indexed yet.</div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Configuration</h2>
        </div>
        <div className="table">
          <div className="table-row header">
            <span>Role</span>
            <span>Members</span>
          </div>
          {roleConfig.map((role) => (
            <div key={role.role} className="table-row">
              <span>{displayRole(role.role)}</span>
              <span className="row-list">
                {role.members.length
                  ? role.members.map((member) => (
                      <Link
                        key={member}
                        className="token-link"
                        to={`/address/${member}`}
                      >
                        {member}
                      </Link>
                    ))
                  : "No members"}
              </span>
            </div>
          ))}
          {configError ? (
            <div className="empty">{configError}</div>
          ) : roleConfigError ? (
            <div className="empty">{roleConfigError}</div>
          ) : !roleConfig.length ? (
            <div className="empty">No roles indexed yet.</div>
          ) : null}
        </div>
      </section>

      <section className="stack">
        <div className="panel">
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
                <span className="muted">
                  Page {eventsCursorStack.length + 1}
                </span>
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
                  <Link className="token-link" to={tokenPath(event.token_id)}>
                    <span className="row-token-name">
                      {displayTokenLabel(
                        tokenById.get(event.token_id)?.name,
                        tokenById.get(event.token_id)?.symbol
                      )}
                    </span>
                  </Link>
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
                  {formatAmount(
                    event.amount,
                    tokenById.get(event.token_id)?.decimals
                  )}
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
            {!events.length ? (
              <div className="empty">No transfer events indexed yet.</div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}
