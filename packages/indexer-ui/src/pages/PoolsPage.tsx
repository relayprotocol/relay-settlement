import { useState } from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { useQueries, useQuery } from "@tanstack/react-query"
import { priceQueries, xerc20Queries, type StatsWindow } from "../api/queries"
import type {
  IndexedContractEvent,
  Xerc20LockboxSnapshot,
  Xerc20LockboxState,
} from "../api/schema"
import { ChainIcon } from "../components/ChainIcon"
import { addressItem, ConfigurationPanel } from "../components/contract"
import { EventPanel, eventColumns, eventKindColumn } from "../components/events"
import {
  AddressLink,
  ContractAddress,
  CopyOverlay,
  LockboxToken,
  TxLink,
  useErc20ViewTokenIds,
} from "../components/links"
import {
  ChartFooter,
  formatTime,
  LineChart,
  Pending,
} from "../components/charts"
import { Picker } from "../components/Picker"
import { SNAPSHOT_ERROR_HINTS } from "../components/status"
import {
  Amount,
  Badge,
  DataTable,
  EmptyState,
  isMaxLimit,
  LoadState,
  MaxLimit,
  Muted,
  Panel,
  RelativeTime,
  type Column,
} from "../components/ui"
import { Tooltip } from "../components/Tooltip"
import { Usd, UsdAmount } from "../components/Usd"
import { usdPrice } from "../depositoryValues"
import { useLabels } from "../labels"
import {
  ADMIN_EVENT_KINDS,
  LOCKBOX_EVENT_KINDS,
  POOL_TYPES,
  poolPath,
  STORED_POOL,
  storedPool,
  usePools,
  type Pool,
} from "../pools"
import { readStorage, writeStorage } from "../storage"
import { useTokens } from "../tokens"
import {
  cx,
  displayTokenLabel,
  formatAmount,
  formatNumber,
  formatPercent,
} from "../utils"

const units = (value: string, decimals?: number) =>
  decimals === undefined ? (
    <Tooltip content="Raw units with unknown decimals">
      <span className="text-fg-muted tabular-nums">{value} raw</span>
    </Tooltip>
  ) : (
    <span className="tabular-nums">
      <Amount value={value} decimals={decimals} places={2} />
    </span>
  )

const limit = (
  value: string | null | undefined,
  decimals?: number,
  privileged = false
) =>
  privileged ? (
    <Tooltip content="Privileged lockbox bypasses limits">
      <span className="text-fg-muted">-</span>
    </Tooltip>
  ) : value == null || isMaxLimit(value) ? (
    <MaxLimit value={value ?? undefined} />
  ) : (
    units(value, decimals)
  )

const lockboxFlow = (data: IndexedContractEvent["data"]) =>
  data.kind === "xerc20_lockbox_deposit" ||
  data.kind === "xerc20_lockbox_withdraw"
    ? data
    : undefined

const scaled = (amount: string, decimals: number, precision: number) =>
  BigInt(amount) * 10n ** BigInt(precision - decimals)

const scaledTotal = (
  snapshots: Xerc20LockboxSnapshot[],
  value: (snapshot: Xerc20LockboxSnapshot) => string,
  precision: number
) =>
  snapshots
    .reduce(
      (sum, snapshot) =>
        sum + scaled(value(snapshot), snapshot.decimals, precision),
      0n
    )
    .toString()

const amount = (
  lockbox: Xerc20LockboxState,
  value: (snapshot: Xerc20LockboxSnapshot) => string
) => {
  const snapshot = lockbox.snapshot
  if (snapshot)
    return (
      <span className="tabular-nums">
        <Amount
          value={value(snapshot)}
          decimals={snapshot.decimals}
          places={2}
        />
      </span>
    )
  return lockbox.error ? (
    <Badge tone="error" title={SNAPSHOT_ERROR_HINTS[lockbox.error]}>
      Failed
    </Badge>
  ) : (
    <Muted />
  )
}

function LockboxAddress({
  address,
  privileged,
}: {
  address: string
  privileged?: boolean
}) {
  return (
    <CopyOverlay value="always">
      <span className="inline-flex items-center gap-(--flow-gap) [--flow-gap:--spacing(1.5)]">
        <AddressLink address={address} />
        {privileged ? (
          <Badge tone="primary" title="Mints and burns without limits">
            Privileged
          </Badge>
        ) : null}
      </span>
    </CopyOverlay>
  )
}

const ratio = (part: bigint, total: bigint) =>
  total > 0n ? Number((part * 10_000n) / total) / 10_000 : 0

const reserveShare = (
  snapshot: Xerc20LockboxSnapshot,
  total: string,
  precision: number
) =>
  ratio(scaled(snapshot.reserve, snapshot.decimals, precision), BigInt(total))

const useReservePrices = (snapshots: Xerc20LockboxSnapshot[]) => {
  const tokenIds = useErc20ViewTokenIds()
  const priced = [
    ...new Set(snapshots.map((snapshot) => snapshot.token.toLowerCase())),
  ].flatMap((token) => {
    const tokenId = tokenIds.get(token)
    return tokenId ? [{ token, tokenId }] : []
  })
  const results = useQueries({
    queries: priced.map(({ tokenId }) => priceQueries.price(tokenId)),
  })
  return {
    pending: results.some((price) => price.data === undefined && !price.error),
    prices: new Map(
      priced.flatMap(({ token }, index) => {
        const price = usdPrice(results[index]?.data)
        return price === undefined ? [] : [[token, Number(price)]]
      })
    ),
  }
}

const reserveValue = (
  snapshot: Xerc20LockboxSnapshot,
  prices: Map<string, number>
) => {
  const price = prices.get(snapshot.token.toLowerCase())
  return price === undefined
    ? undefined
    : (Number(snapshot.reserve) / 10 ** snapshot.decimals) * price
}

const lockboxColumns = (
  total: string,
  precision: number,
  tokenIds: Map<string, string>,
  prices: Map<string, number>
): Column<Xerc20LockboxState>[] => [
  {
    cell: (lockbox) => (
      <LockboxAddress
        address={lockbox.lockbox}
        privileged={lockbox.snapshot?.privileged}
      />
    ),
    header: "Lockbox",
    title: "Lockbox contract",
    sortValue: (lockbox) => lockbox.lockbox,
  },
  {
    cell: ({ snapshot }) =>
      snapshot ? (
        <LockboxToken
          token={snapshot.token}
          symbol={snapshot.symbol}
          tokenIds={tokenIds}
        />
      ) : (
        <Muted />
      ),
    header: "Token",
    title: "Token held in reserve",
    sortValue: ({ snapshot }) => snapshot?.symbol,
  },
  {
    align: "right",
    cell: ({ snapshot }) =>
      snapshot ? (
        <span className="tabular-nums">
          {formatPercent(reserveShare(snapshot, total, precision))}
        </span>
      ) : (
        <Muted />
      ),
    header: "Share",
    title: "Share of total reserves",
    sortValue: ({ snapshot }) =>
      snapshot && reserveShare(snapshot, total, precision),
  },
  {
    align: "right",
    cell: (lockbox) => amount(lockbox, (snapshot) => snapshot.reserve),
    header: "Reserve",
    title: "Lockbox token balance",
    sortValue: ({ snapshot }) =>
      snapshot && Number(snapshot.reserve) / 10 ** snapshot.decimals,
  },
  {
    align: "right",
    cell: ({ snapshot }) => {
      const value = snapshot ? reserveValue(snapshot, prices) : undefined
      return value === undefined ? (
        <Muted />
      ) : (
        <span className="tabular-nums">
          <Usd value={value} />
        </span>
      )
    },
    header: "Value",
    title: "Reserve value in USD",
    sortValue: ({ snapshot }) => snapshot && reserveValue(snapshot, prices),
  },
  {
    align: "right",
    cell: ({ snapshot }) =>
      snapshot ? (
        limit(snapshot.burn_limit, snapshot.decimals, snapshot.privileged)
      ) : (
        <Muted />
      ),
    header: "Burn",
    title: "Current burn limit",
  },
  {
    align: "right",
    cell: ({ snapshot }) =>
      snapshot ? (
        limit(snapshot.mint_limit, snapshot.decimals, snapshot.privileged)
      ) : (
        <Muted />
      ),
    header: "Mint",
    title: "Current mint limit",
  },
  {
    align: "right",
    cell: ({ error, snapshot }) => (
      <span className={error ? "text-error-fg" : undefined}>
        <RelativeTime
          value={snapshot?.observed_at}
          hint={
            error
              ? SNAPSHOT_ERROR_HINTS[error]
              : snapshot
                ? `Block ${formatNumber(snapshot.block_number)}`
                : undefined
          }
        />
      </span>
    ),
    header: "Observed",
    title: "Last successful lockbox read",
    sortValue: (lockbox) => lockbox.snapshot?.observed_at,
  },
]

const lockboxEventColumns = (
  reserves: Map<string, Xerc20LockboxSnapshot>,
  tokenIds: Map<string, string>
): Column<IndexedContractEvent>[] => [
  {
    cell: (event) => <RelativeTime value={event.block_timestamp} />,
    header: "Time",
    title: "Event block time",
  },
  eventKindColumn,
  {
    cell: ({ data }) => {
      const flow = lockboxFlow(data)
      return !flow
        ? null
        : flow.swap
          ? "Swap"
          : flow.kind === "xerc20_lockbox_deposit"
            ? "Add liquidity"
            : "Remove liquidity"
    },
    header: "Kind",
    title: "Swap or liquidity change",
  },
  {
    cell: (event) => {
      const snapshot = reserves.get(event.contract_address.toLowerCase())
      return snapshot ? (
        <LockboxToken
          token={snapshot.token}
          symbol={snapshot.symbol}
          tokenIds={tokenIds}
        />
      ) : (
        <AddressLink address={event.contract_address} />
      )
    },
    header: "Token",
    title: "Lockbox reserve token",
  },
  {
    align: "right",
    cell: (event) => {
      const flow = lockboxFlow(event.data)
      return flow
        ? units(
            flow.amount,
            reserves.get(event.contract_address.toLowerCase())?.decimals
          )
        : null
    },
    header: "Amount",
    title: "Reserve token amount",
  },
  {
    cell: ({ data }) => {
      const flow = lockboxFlow(data)
      return flow ? <AddressLink address={flow.recipient} /> : null
    },
    header: "Recipient",
    title: "Account receiving the tokens",
  },
  {
    cell: (event) => <TxLink hash={event.tx_hash} />,
    header: "Transaction",
    title: "Event transaction hash",
  },
]

const adminColumns = (reserves: Map<string, Xerc20LockboxSnapshot>) =>
  eventColumns({
    decimals: ({ data }) =>
      data.kind === "xerc20_bridge_limits_set"
        ? reserves.get(data.bridge.toLowerCase())?.decimals
        : undefined,
  })

const WEEK_WINDOW: StatsWindow = { bucketMinutes: 60, hours: 168 }

const usePoolReserves = (pool: Pool) => {
  const lockboxes = useQuery(xerc20Queries(pool.address).lockboxes())
  const rows = lockboxes.data?.lockboxes
  const reserves = new Map(
    (rows ?? []).flatMap(({ lockbox, snapshot }) =>
      snapshot ? [[lockbox.toLowerCase(), snapshot]] : []
    )
  )
  const snapshots = [...reserves.values()]
  const precision = Math.max(
    0,
    ...snapshots.map((snapshot) => snapshot.decimals)
  )
  return {
    lockboxes,
    precision,
    reserve: scaledTotal(snapshots, (snapshot) => snapshot.reserve, precision),
    reserves,
    rows,
    snapshots,
  }
}

function PoolSummary({ pool }: { pool: Pool }) {
  const { lockboxes, precision, reserve, reserves, snapshots } =
    usePoolReserves(pool)
  const { pending: pricing, prices } = useReservePrices(snapshots)
  const { data: history } = useQuery(
    xerc20Queries(pool.address).stats(WEEK_WINDOW)
  )
  const values = snapshots.flatMap(
    (snapshot) => reserveValue(snapshot, prices) ?? []
  )
  const value = values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined
  const current = BigInt(reserve)
  const peak = (history?.buckets ?? []).reduce((peak, bucket) => {
    const total = bucket.reserves.reduce((sum, item) => {
      const places = reserves.get(item.lockbox.toLowerCase())?.decimals
      return places === undefined
        ? sum
        : sum + scaled(item.reserve, places, precision)
    }, 0n)
    return total > peak ? total : peak
  }, current)
  const level = history && snapshots.length ? ratio(current, peak) : 0

  const missing = (pending: boolean) => <Muted>{pending ? "..." : "-"}</Muted>
  const stats = [
    {
      hint: "Total lockbox reserves",
      value: snapshots.length
        ? formatAmount(reserve, precision, 2)
        : missing(lockboxes.isPending),
    },
    {
      hint: "Reserve value in USD",
      value:
        value === undefined ? (
          missing(lockboxes.isPending || pricing)
        ) : (
          <span className="text-success-fg">
            <UsdAmount value={value} />
          </span>
        ),
    },
  ]

  return (
    <div className="flex w-full flex-col gap-3 sm:w-md sm:items-end">
      <dl className="flex flex-wrap items-center gap-y-1 text-xl font-semibold tabular-nums sm:justify-end sm:text-2xl">
        {stats.map((stat) => (
          <div
            key={stat.hint}
            className="border-line-strong not-first:ml-4 not-first:border-l not-first:pl-4"
          >
            <dt className="sr-only">{stat.hint}</dt>
            <Tooltip content={stat.hint}>
              <dd className="whitespace-nowrap">{stat.value}</dd>
            </Tooltip>
          </div>
        ))}
      </dl>
      <Tooltip content="Reserve relative to 7d maximum">
        <div
          role="meter"
          aria-label="Reserve relative to 7d maximum"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          className="h-3 w-full overflow-hidden rounded-sm bg-element"
        >
          <div
            className={cx(
              "h-full rounded-sm bg-chart/80 transition-[width] duration-500",
              level > 0 && "min-w-1"
            )}
            style={{ width: `${level * 100}%` }}
          />
        </div>
      </Tooltip>
    </div>
  )
}

function PoolPicker({ pools, pool }: { pools?: Pool[]; pool?: Pool }) {
  const navigate = useNavigate()
  const labels = useLabels()

  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 p-4">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2">
          <ChainIcon
            id={pool && labels.networkId(pool.chain)}
            name={pool ? labels.chain(pool.chain) : ""}
            className="size-12 sm:row-span-2"
            eager
          />
          <div className="flex flex-wrap items-center gap-2 sm:self-end">
            <Picker
              noun="pool"
              options={(pools ?? []).map(({ address, chain, name }) => ({
                hint: address,
                icon: (
                  <ChainIcon
                    id={labels.networkId(chain)}
                    name={labels.chain(chain)}
                  />
                ),
                id: address,
                name,
              }))}
              value={pool?.address ?? ""}
              label="Select pool"
              onChange={(next) => {
                writeStorage(STORED_POOL, next)
                navigate(poolPath(next))
              }}
            />
            {pool ? (
              <Badge title="Pool type">{POOL_TYPES[pool.type]}</Badge>
            ) : null}
          </div>
          {pool ? (
            <ContractAddress
              chain={pool.chain}
              address={pool.address}
              label="Token contract"
            />
          ) : pools ? null : (
            <span
              aria-hidden
              className="col-span-2 h-8 w-80 max-w-full justify-self-start rounded-md bg-element motion-safe:animate-pulse sm:col-span-1 sm:col-start-2"
            />
          )}
        </div>
        {pool ? <PoolSummary pool={pool} /> : null}
      </div>
    </section>
  )
}

function AssetsPanel({ pool }: { pool: Pool }) {
  const { precision, reserves } = usePoolReserves(pool)
  const labels = useLabels()
  const tokens = useTokens()
  const tokenIds = useErc20ViewTokenIds()
  const stats = useQuery(xerc20Queries(pool.address).stats())
  const storageKey = `pools:${pool.address}:lockbox`
  const [choice, setChoice] = useState(() => readStorage(storageKey))
  const [selected, setSelected] = useState<number>()
  const weight = (
    snapshot: Xerc20LockboxSnapshot,
    reserve = snapshot.reserve
  ) => scaled(reserve, snapshot.decimals, precision)
  const entries = [...reserves]
    .map(([lockbox, snapshot]) => ({
      lockbox,
      snapshot,
      token: tokens?.get(tokenIds.get(snapshot.token.toLowerCase()) ?? ""),
    }))
    .toSorted((a, b) => Number(weight(b.snapshot) - weight(a.snapshot)))
  const current =
    entries.find((entry) => entry.lockbox === choice) ?? entries[0]
  const buckets = stats.data?.buckets ?? []
  const shares = buckets.map((bucket) => {
    const amounts = new Map(
      bucket.reserves.map((item) => [item.lockbox.toLowerCase(), item.reserve])
    )
    const reserve = current && amounts.get(current.lockbox)
    if (!current || reserve === undefined) return null
    const total = entries.reduce(
      (sum, entry) =>
        sum + weight(entry.snapshot, amounts.get(entry.lockbox) ?? "0"),
      0n
    )
    return ratio(weight(current.snapshot, reserve), total)
  })
  const name = (entry: (typeof entries)[number]) =>
    displayTokenLabel(
      entry.token?.name,
      entry.token?.symbol ?? entry.snapshot.symbol
    )
  const index = selected ?? (shares.length ? shares.length - 1 : undefined)
  const share = index == null ? undefined : shares[index]
  const bucket = index == null ? undefined : buckets[index]
  const reserve = bucket?.reserves.find(
    (item) => item.lockbox.toLowerCase() === current?.lockbox
  )?.reserve
  const end =
    bucket && stats.data
      ? Date.parse(bucket.start) + stats.data.bucket_minutes * 60_000
      : undefined
  const missing = stats.data ? <Muted /> : <Pending error={stats.error} />

  return (
    <Panel
      title="Reserve Share"
      actions={
        <Picker
          noun="token"
          options={entries.map((entry) => ({
            hint: entry.lockbox,
            icon: (
              <ChainIcon
                id={labels.originNetworkId(entry.token?.origin_chain_id)}
                name={labels.originChain(entry.token?.origin_chain_id)}
                className="size-[1.25em]"
              />
            ),
            id: entry.lockbox,
            name: name(entry),
          }))}
          value={current?.lockbox ?? ""}
          label="Select token"
          onChange={(next) => {
            if (!next) return
            writeStorage(storageKey, next)
            setChoice(next)
          }}
          variant="field"
          align="end"
          className="w-44"
        />
      }
    >
      <div className="px-4 pt-3 pb-2">
        <LineChart
          points={stats.data && current ? shares : undefined}
          fromZero
          label={`${current ? name(current) : "Lockbox"} share over the last 24 hours`}
          selected={selected}
          onSelect={setSelected}
        />
        <ChartFooter
          label={selected != null && end ? formatTime(end) : "Last 24 hours"}
          stats={[
            {
              label: "Share",
              value: share != null ? formatPercent(share) : missing,
            },
            {
              label: "Reserve",
              value:
                reserve !== undefined && current ? (
                  <Amount
                    value={reserve}
                    decimals={current.snapshot.decimals}
                    places={2}
                  />
                ) : (
                  missing
                ),
            },
          ]}
        />
      </div>
    </Panel>
  )
}

function PoolContent({ pool }: { pool: Pool }) {
  const queries = xerc20Queries(pool.address)
  const { lockboxes, precision, reserve, reserves, rows, snapshots } =
    usePoolReserves(pool)
  const { prices } = useReservePrices(snapshots)
  const { data: response, error } = useQuery(queries.state())
  const failed = (rows ?? []).filter((lockbox) => lockbox.error)
  const tokenIds = useErc20ViewTokenIds()

  return (
    <>
      <AssetsPanel pool={pool} />
      <Panel
        title="Reserves"
        badge={
          failed.length ? (
            <Badge tone="warning" title="Failed lockbox reads">
              {failed.length} unreadable
            </Badge>
          ) : null
        }
      >
        <DataTable
          columns={lockboxColumns(reserve, precision, tokenIds, prices)}
          rows={rows}
          rowKey={(lockbox) => lockbox.lockbox}
          empty="No lockboxes"
          defaultSort={{ column: 2, descending: true }}
          pending={lockboxes.isPending}
          error={lockboxes.error}
        />
      </Panel>
      <EventPanel
        title="Activity"
        events={queries.events}
        kinds={LOCKBOX_EVENT_KINDS}
        columns={lockboxEventColumns(reserves, tokenIds)}
      />
      <EventPanel
        title="Admin Events"
        events={queries.events}
        kinds={ADMIN_EVENT_KINDS}
        columns={adminColumns(reserves)}
      />
      <ConfigurationPanel
        response={response}
        error={error}
        items={[
          addressItem("contract", response?.contract_address),
          addressItem(
            "lockbox",
            response?.state?.snapshot?.configuration.lockbox
          ),
          addressItem("owner", response?.state?.snapshot?.configuration.owner),
        ]}
      />
    </>
  )
}

export default function PoolsPage() {
  const { pool: id } = useParams()
  const { data: pools, error } = usePools()
  const pool = pools?.find((option) => option.address === id?.toLowerCase())

  const fallback = pools && !pool ? storedPool(pools) : undefined
  if (fallback) return <Navigate to={poolPath(fallback.address)} replace />

  return (
    <>
      {pools || !error ? <PoolPicker pools={pools} pool={pool} /> : null}
      {pool ? (
        <PoolContent key={pool.address} pool={pool} />
      ) : pools || error ? (
        <Panel title="Pool">
          <EmptyState>
            {pools ? "No pools" : <LoadState error={error} />}
          </EmptyState>
        </Panel>
      ) : null}
    </>
  )
}
