import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  Event,
  Token,
  fetchBalancesForAddress,
  fetchEvents,
  fetchToken,
  refreshAddressBalances,
} from "../api"
import {
  displayTokenLabel,
  displayTokenName,
  formatAmount,
  formatTimestamp,
  displayAddress,
  shortHash,
  shortTokenId,
  tokenPath,
  txUrl,
  ZERO_ADDRESS,
  addressUrl,
} from "../utils"

export default function AddressPage() {
  const { address } = useParams()
  const wallet = address ?? ""
  const [balances, setBalances] = useState<
    Array<{ token_id: string; balance: string }>
  >([])
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
  const [error, setError] = useState<string>("")
  const [refreshingBalances, setRefreshingBalances] = useState<boolean>(false)
  const [tokenDetails, setTokenDetails] = useState<Record<string, Token>>({})

  const EVENTS_PER_PAGE = 20
  const eventsPage = eventsCursorStack.length + 1

  useEffect(() => {
    setEventsCursor(null)
    setEventsCursorStack([])
    setEventsNextCursor(null)
    setHasTransfers(false)
    setBalancesCursor(null)
    setBalancesCursorStack([])
    setBalancesNextCursor(null)
  }, [wallet])

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
      setError(err instanceof Error ? err.message : "Failed to load tokens")
    }
  }

  const loadBalances = async () => {
    if (!wallet) return
    try {
      const data = await fetchBalancesForAddress(
        wallet,
        100,
        balancesCursor ?? undefined
      )
      setBalances(data.data)
      setBalancesNextCursor(data.nextCursor ?? null)
      await loadTokenDetails(data.data.map((row) => row.token_id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load balances")
    }
  }

  const loadEvents = async () => {
    if (!wallet) return
    try {
      const data = await fetchEvents(
        undefined,
        wallet,
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
      await loadTokenDetails(data.data.map((row) => row.token_id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load transfers")
    }
  }

  useEffect(() => {
    void loadBalances()
    void loadEvents()
    const interval = setInterval(() => {
      void loadBalances()
      void loadEvents()
    }, 5000)
    return () => clearInterval(interval)
  }, [wallet, eventsCursor, balancesCursor])

  const title = wallet ? displayAddress(wallet) : "Address"
  const hasBalances = balances.length > 0

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

  const handleRefreshBalances = async () => {
    if (!wallet || refreshingBalances) return
    try {
      setRefreshingBalances(true)
      await refreshAddressBalances(wallet)
      await loadBalances()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to refresh balances"
      )
    } finally {
      setRefreshingBalances(false)
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Address detail</p>
          <h1>{title}</h1>
          <p className="muted">
            <Link className="token-link" to="/">
              Back to overview
            </Link>
            {wallet ? (
              <>
                {" "}
                ·{" "}
                <a
                  className="token-link"
                  href={addressUrl(wallet)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on explorer
                </a>
              </>
            ) : null}
          </p>
        </div>
        <button
          className="btn"
          onClick={handleRefreshBalances}
          disabled={!wallet || refreshingBalances}
        >
          {refreshingBalances ? "Refreshing..." : "Refresh balances"}
        </button>
      </header>

      {error ? <div className="banner">{error}</div> : null}

      {hasBalances ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Balances</h2>
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
              <span>Token</span>
              <span>Balance</span>
            </div>
            {balances.map((balance) => (
              <div key={balance.token_id} className="table-row">
                <span>
                  <Link className="token-link" to={tokenPath(balance.token_id)}>
                    {displayTokenName(tokenDetails[balance.token_id]?.name)}{" "}
                    <span className="muted">
                      #{shortTokenId(balance.token_id)}
                    </span>
                  </Link>
                </span>
                <span>
                  {formatAmount(
                    balance.balance,
                    tokenDetails[balance.token_id]?.decimals
                  )}
                </span>
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
                  <Link className="token-link" to={tokenPath(event.token_id)}>
                    <span className="row-token-name">
                      {displayTokenLabel(
                        tokenDetails[event.token_id]?.name,
                        tokenDetails[event.token_id]?.symbol
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
                    tokenDetails[event.token_id]?.decimals
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
          </div>
        </section>
      ) : null}
    </div>
  )
}
