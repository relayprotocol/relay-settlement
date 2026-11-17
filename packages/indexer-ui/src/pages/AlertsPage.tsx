import { useState } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import {
  allocatorQueries,
  executorQueries,
  hubQueries,
  indexerQueries,
  oracleQueries,
  chainQueries,
  PAGE_SIZE,
  priceOracleQueries,
  xerc20Queries,
} from "../api/queries"
import type {
  Alert,
  AlertEvent,
  AlertSeverity,
  Chain,
  ChainConfigView,
  ContractBindingState,
  ContractConfiguration,
  ContractConfigurationState,
  DeficitCheck,
  DeficitStatus,
  DepositoryDetails,
  GetConfigResponse,
  GetContractConfigurationResponse,
  ListXerc20LockboxesResponse,
  PriceFeed,
  SnapshotDetails,
  SnapshotStatus,
  Xerc20LockboxState,
} from "../api/schema"
import {
  eventKindLabel,
  FieldList,
  MissingBindings,
} from "../components/events"
import {
  AccountLink,
  AddressLink,
  ChainLink,
  HashText,
  HubTokenLink,
  LockboxToken,
  PoolLink,
  useErc20ViewTokenIds,
} from "../components/links"
import { ListPager, useListPages } from "../components/pagination"
import { chainOptions, Picker } from "../components/Picker"
import {
  alertTone,
  DEFICIT_STATUS_ORDER,
  DeficitStatusBadge,
  DeviationBadge,
  feedAlert,
  PRICE_ERROR_HINTS,
  priceExpired,
  PriceStatusBadge,
  SNAPSHOT_ERROR_HINTS,
  StalenessBadge,
  stalenessRank,
} from "../components/status"
import { UsdAmount, UsdValue } from "../components/Usd"
import {
  Amount,
  Badge,
  CollapsedList,
  DataTable,
  isMaxLimit,
  MaxLimit,
  Muted,
  Pager,
  Panel,
  RelativeTime,
  SegmentedControl,
  TitleCount,
  type Column,
} from "../components/ui"
import { HUB_CHAIN } from "../explorers"
import { useLabels } from "../labels"
import { isNativeAsset } from "../origins"
import { usePools, type Pool } from "../pools"
import { roleName } from "../roles"
import { formatDuration, formatNumber, formatPercent, unixTime } from "../utils"

type View = "issues" | "healthy" | "unknown"

const SECTION_PAGE_SIZE = 10

const VIEWS: Array<{ label: string; value: View }> = [
  { label: "Problem", value: "issues" },
  { label: "Healthy", value: "healthy" },
  { label: "Unknown", value: "unknown" },
]

function IssuePanel<T>({
  title,
  hint,
  noun,
  rows,
  classify,
  columns,
  rowKey,
  defaultSort,
  issuesEmpty = "No issues",
  pending,
  error,
}: {
  title: string
  hint: string
  noun: string
  rows?: T[]
  classify: (row: T) => View
  columns: Column<T>[]
  rowKey: (row: T) => string
  defaultSort?: { column: number; descending: boolean }
  issuesEmpty?: string
  pending?: boolean
  error?: Error | null
}) {
  const [view, setView] = useState<View>("issues")
  const shown = error
    ? undefined
    : rows?.filter((row) => classify(row) === view)
  const pages = useListPages(shown?.length, view, SECTION_PAGE_SIZE)

  return (
    <Panel
      title={title}
      hint={hint}
      badge={
        shown ? (
          <TitleCount
            label={view === "issues" ? "issues" : noun}
            shown={shown.length}
            total={shown.length}
            filtered={false}
          />
        ) : null
      }
      actions={
        <>
          <SegmentedControl
            label={`${title} rows`}
            options={VIEWS}
            value={view}
            onChange={setView}
          />
          <ListPager pages={pages} />
        </>
      }
    >
      <DataTable
        columns={columns}
        rows={shown}
        page={pages}
        defaultSort={defaultSort}
        rowKey={rowKey}
        empty={
          view === "issues"
            ? issuesEmpty
            : view === "healthy"
              ? `No healthy ${noun}`
              : `No unknown ${noun}`
        }
        pending={pending}
        error={error}
      />
    </Panel>
  )
}

const DEFICIT_VIEWS: Record<DeficitStatus, View> = {
  confirmed: "issues",
  unconfirmed: "issues",
  sufficient: "healthy",
  unavailable: "unknown",
}

const shortfall = (check: DeficitCheck) => {
  const comparison = check.comparison
  if (!comparison) return undefined
  const value =
    BigInt(comparison.hub.total_supply) - BigInt(comparison.depository.balance)
  return value > 0n ? value.toString() : "0"
}

const amount = (value: string | undefined, check: DeficitCheck) =>
  value == null ? (
    <Muted />
  ) : (
    <Amount value={value} decimals={check.comparison?.depository.decimals} />
  )

const DEFICIT_COLUMNS: Column<DeficitCheck>[] = [
  {
    cell: (check) => <HubTokenLink tokenId={check.token_id} />,
    header: "Token",
    title: "Token name or symbol",
  },
  {
    cell: (check) =>
      check.target?.chain ? (
        <ChainLink
          chain={check.target.chain}
          depository={check.target.depository}
        />
      ) : (
        <Muted />
      ),
    header: "Chain",
    title: "Depository chain",
    sortValue: (check) => check.target?.chain,
  },
  {
    cell: (check) => <DeficitStatusBadge check={check} />,
    header: "Status",
    title: "Supply comparison status",
    sortValue: (check) => DEFICIT_STATUS_ORDER.indexOf(check.status),
  },
  {
    align: "right",
    cell: (check) => amount(shortfall(check), check),
    header: "Deficit",
    title: "Hub supply above depository",
    sortValue: (check) => {
      const value = shortfall(check)
      return value == null
        ? undefined
        : Number(value) / 10 ** (check.comparison?.depository.decimals ?? 0)
    },
  },
  {
    align: "right",
    cell: (check) => {
      const value = shortfall(check)
      return value && value !== "0" ? (
        <UsdValue
          tokenId={check.token_id}
          amount={value}
          decimals={check.comparison?.depository.decimals}
          tone="error"
        />
      ) : (
        <Muted />
      )
    },
    header: "Value",
    title: "Deficit in USD",
  },
  {
    align: "right",
    cell: (check) => amount(check.comparison?.hub.total_supply, check),
    header: "Hub",
    title: "Hub total supply",
  },
  {
    align: "right",
    cell: (check) => amount(check.comparison?.depository.balance, check),
    header: "Depository",
    title: "Depository balance",
  },
  {
    align: "right",
    cell: (check) => <RelativeTime value={check.deficit_since} />,
    header: "Since",
    title: "Deficit first seen",
    sortValue: (check) => check.deficit_since,
  },
  {
    align: "right",
    cell: (check) => <RelativeTime value={check.checked_at} />,
    header: "Checked",
    title: "Last check",
  },
]

function Deficits() {
  const { data, error } = useQuery(hubQueries.deficits())
  return (
    <IssuePanel
      title="Hub Deficits"
      hint="Depository balance below Hub supply"
      noun="tokens"
      rows={data}
      classify={(check) => DEFICIT_VIEWS[check.status]}
      columns={DEFICIT_COLUMNS}
      rowKey={(check) => check.token_id}
      defaultSort={{ column: 2, descending: false }}
      issuesEmpty="No deficits"
      error={error}
    />
  )
}

type ActivityState = AlertSeverity | "inactive" | "cleared"

const ACTIVITY_HEALTH: Record<ActivityState, Health> = {
  error: { label: "Error", tone: "error", hint: "Active error alert" },
  warn: { label: "Warning", tone: "warning", hint: "Active warning alert" },
  inactive: {
    label: "Inactive",
    tone: "neutral",
    hint: "Inactive alert with no recent occurrences",
  },
  cleared: {
    label: "Cleared",
    tone: "success",
    hint: "Recovery confirmed by a check",
  },
}

const activityHealth = (event: AlertEvent): Health =>
  ACTIVITY_HEALTH[
    event.resolved_at
      ? "cleared"
      : event.active
        ? event.alert.severity
        : "inactive"
  ]

type Health = {
  label: string
  tone: "error" | "warning" | "neutral" | "success"
  hint: string
}

const HEALTH_ORDER = ["error", "warning", "neutral", "success"]

const healthy = (label: string, hint: string): Health => ({
  label,
  tone: "success",
  hint,
})

const unavailable = (hint: string): Health => ({
  label: "Unavailable",
  tone: "neutral",
  hint,
})

const healthView = (tone: Health["tone"]): View =>
  tone === "success" ? "healthy" : tone === "neutral" ? "unknown" : "issues"

const healthColumn = <T,>(health: (row: T) => Health): Column<T> => ({
  cell: (row) => {
    const { label, tone, hint } = health(row)
    return (
      <Badge tone={tone} title={hint}>
        {label}
      </Badge>
    )
  },
  header: "Status",
  title: "Alert check result",
  sortValue: (row) => HEALTH_ORDER.indexOf(health(row).tone),
})

const SNAPSHOT_HINTS: Record<SnapshotStatus, string> = {
  fresh: "Snapshot is current",
  stale: "Snapshot is stale",
  failed: "Last snapshot attempt failed",
  pending: "No snapshot yet",
  disabled: "Snapshots disabled for chain",
}

const activeAlerts = <K extends Alert["kind"]>(
  events: AlertEvent[] | undefined,
  kind: K,
  key: (event: AlertEvent) => string
) =>
  new Map(
    (events ?? [])
      .toReversed()
      .flatMap((event) =>
        event.active && event.alert.kind === kind
          ? [
              [
                key(event),
                event as AlertEvent & { alert: Extract<Alert, { kind: K }> },
              ],
            ]
          : []
      )
  )

type RouterRow = {
  snapshot: SnapshotDetails
  event?: AlertEvent & { alert: Extract<Alert, { kind: "router_residual" }> }
}

const routerKey = (chain: string, address: string) =>
  `${chain}:${address.toLowerCase()}`

const routerHealth = (row: RouterRow): Health =>
  row.event
    ? {
        label: "Residual",
        tone: alertTone(row.event.alert),
        hint: "Above USD threshold",
      }
    : row.snapshot.status === "fresh"
      ? healthy("Clear", "No active residual alert")
      : unavailable(row.snapshot.error ?? SNAPSHOT_HINTS[row.snapshot.status])

const RESIDUAL_COLUMNS: Column<RouterRow>[] = [
  {
    cell: ({ snapshot }) => <ChainLink chain={snapshot.chain} />,
    header: "Chain",
    title: "Router chain",
    sortValue: ({ snapshot }) => snapshot.chain,
  },
  {
    cell: ({ snapshot }) => (
      <AccountLink address={snapshot.target} chain={snapshot.chain} />
    ),
    header: "Router",
    title: "MulticallRouter address",
  },
  healthColumn(routerHealth),
  {
    align: "right",
    cell: ({ event }) =>
      event ? <UsdAmount value={event.alert.total_usd} /> : <Muted />,
    header: "Value",
    title: "Priced residual in USD",
    sortValue: ({ event }) => event?.alert.total_usd ?? 0,
  },
  {
    cell: ({ event, snapshot }) =>
      event ? (
        <CollapsedList>
          {event.alert.currencies.map((currency) =>
            isNativeAsset(currency) ? (
              <span key={currency}>Native</span>
            ) : (
              <AccountLink
                key={currency}
                address={currency}
                chain={snapshot.chain}
              />
            )
          )}
        </CollapsedList>
      ) : (
        <Muted />
      ),
    header: "Currencies",
    title: "Priced residual currencies",
  },
  {
    align: "right",
    cell: ({ event }) => <RelativeTime value={event?.first_seen} />,
    header: "Since",
    title: "Residual first logged",
    sortValue: ({ event }) => event?.first_seen,
  },
  {
    align: "right",
    cell: ({ snapshot }) => <RelativeTime value={snapshot.last_success_at} />,
    header: "Checked",
    title: "Last successful snapshot",
  },
]

function RouterResiduals() {
  const snapshots = useQuery(indexerQueries.snapshots())
  const alerts = useQuery(indexerQueries.activeAlerts("router_residual"))
  const events = activeAlerts(alerts.data, "router_residual", (event) =>
    routerKey(event.chain, event.deployment)
  )
  const rows =
    alerts.data &&
    snapshots.data?.snapshots.flatMap((snapshot) =>
      snapshot.category === "routers"
        ? [
            {
              snapshot,
              event: events.get(routerKey(snapshot.chain, snapshot.target)),
            },
          ]
        : []
    )
  return (
    <IssuePanel
      title="Router Residuals"
      hint="Router balances above USD threshold"
      noun="routers"
      rows={rows}
      classify={(row) => healthView(routerHealth(row).tone)}
      columns={RESIDUAL_COLUMNS}
      rowKey={({ snapshot }) => routerKey(snapshot.chain, snapshot.target)}
      defaultSort={{ column: 2, descending: false }}
      issuesEmpty="No router residuals"
      error={snapshots.error ?? alerts.error}
    />
  )
}

type PoolLockboxes = { pool: Pool; data: ListXerc20LockboxesResponse }

const usePoolLockboxes = () => {
  const { data: pools, error } = usePools()
  return useQueries({
    queries: (pools ?? []).map((pool) =>
      xerc20Queries(pool.address).lockboxes()
    ),
    combine: (results) => ({
      data:
        pools && results.every((result) => result.data)
          ? pools.flatMap((pool, index) => {
              const data = results[index]?.data
              return data ? [{ pool, data }] : []
            })
          : undefined,
      error: error ?? results.find((result) => result.error)?.error ?? null,
    }),
  })
}

const poolDecimals = (data: ListXerc20LockboxesResponse) =>
  (
    data.lockboxes.find((state) => state.snapshot?.privileged) ??
    data.lockboxes.find((state) => state.snapshot)
  )?.snapshot?.decimals

const poolAlert = <K extends Alert["kind"]>(
  alerts: Alert[] | undefined,
  kind: K
) =>
  alerts?.find(
    (alert): alert is Extract<Alert, { kind: K }> => alert.kind === kind
  )

const POOL_COLUMN: Column<PoolLockboxes> = {
  cell: ({ pool }) => <PoolLink pool={pool} />,
  header: "Pool",
  title: "xERC20 address",
}

type LockboxRow = PoolLockboxes & { state: Xerc20LockboxState }

const depletion = (row: LockboxRow) =>
  poolAlert(row.state.alerts, "xerc20_lockbox_depleted")

const lockboxHealth = (row: LockboxRow): Health => {
  const alert = depletion(row)
  return alert
    ? {
        label: "Depleted",
        tone: alertTone(alert),
        hint: "Lockbox capacity below 1% supply",
      }
    : row.state.error
      ? unavailable(SNAPSHOT_ERROR_HINTS[row.state.error])
      : !row.data.checks_available
        ? unavailable("Pool checks incomplete")
        : row.state.snapshot
          ? healthy("Funded", "Capacity at least 1% supply")
          : unavailable(SNAPSHOT_HINTS.pending)
}

const lockboxShare = ({ data, state }: LockboxRow) =>
  state.snapshot && data.supply && Number(data.supply.total_supply) > 0
    ? Number(state.snapshot.capacity) / Number(data.supply.total_supply)
    : undefined

function LockboxSymbol({ state }: { state: Xerc20LockboxState }) {
  const tokenIds = useErc20ViewTokenIds()
  return state.snapshot ? (
    <LockboxToken
      token={state.snapshot.token}
      symbol={state.snapshot.symbol}
      tokenIds={tokenIds}
    />
  ) : (
    <Muted />
  )
}

const LOCKBOX_COLUMNS: Column<LockboxRow>[] = [
  POOL_COLUMN,
  {
    cell: ({ state }) => <AddressLink address={state.lockbox} />,
    header: "Lockbox",
    title: "Lockbox address",
  },
  {
    cell: ({ state }) => <LockboxSymbol state={state} />,
    header: "Asset",
    title: "Lockbox asset",
    sortValue: ({ state }) => state.snapshot?.symbol,
  },
  healthColumn(lockboxHealth),
  {
    align: "right",
    cell: ({ state }) =>
      state.snapshot ? (
        <Amount
          value={state.snapshot.capacity}
          decimals={state.snapshot.decimals}
        />
      ) : (
        <Muted />
      ),
    header: "Capacity",
    title: "Reserve bounded by burn limit",
    sortValue: ({ state }) =>
      state.snapshot
        ? Number(state.snapshot.capacity) / 10 ** state.snapshot.decimals
        : undefined,
  },
  {
    align: "right",
    cell: (row) => {
      const share = lockboxShare(row)
      return share === undefined ? <Muted /> : formatPercent(share)
    },
    header: "Share",
    title: "Capacity share of supply",
    sortValue: lockboxShare,
  },
  {
    align: "right",
    cell: (row) => <RelativeTime value={depletion(row)?.depleted_since} />,
    header: "Since",
    title: "Depleted since",
    sortValue: (row) => depletion(row)?.depleted_since,
  },
  {
    align: "right",
    cell: ({ state }) => <RelativeTime value={state.snapshot?.observed_at} />,
    header: "Checked",
    title: "Last successful lockbox read",
  },
]

const reserveDeficit = ({ data }: PoolLockboxes) =>
  poolAlert(data.alerts, "xerc20_reserve_deficit")

const reserveHealth = (row: PoolLockboxes): Health => {
  const alert = reserveDeficit(row)
  return alert
    ? {
        label: "Deficit",
        tone: alertTone(alert),
        hint: "Supply above lockbox reserves",
      }
    : row.data.checks_available
      ? healthy("Backed", "Reserves cover the supply")
      : unavailable("Pool checks incomplete")
}

const reserveSum = ({ data }: PoolLockboxes) =>
  data.lockboxes
    .reduce((sum, state) => sum + BigInt(state.snapshot?.reserve ?? "0"), 0n)
    .toString()

const RESERVE_COLUMNS: Column<PoolLockboxes>[] = [
  POOL_COLUMN,
  healthColumn(reserveHealth),
  {
    align: "right",
    cell: (row) => {
      const deficit = reserveDeficit(row)
      return deficit ? (
        <Amount value={deficit.deficit} decimals={deficit.decimals} />
      ) : (
        <Muted />
      )
    },
    header: "Deficit",
    title: "Supply above reserves",
  },
  {
    align: "right",
    cell: ({ data }) =>
      data.supply ? (
        <Amount
          value={data.supply.total_supply}
          decimals={poolDecimals(data)}
        />
      ) : (
        <Muted />
      ),
    header: "Supply",
    title: "xERC20 total supply",
  },
  {
    align: "right",
    cell: (row) => (
      <Amount
        value={reserveDeficit(row)?.reserves ?? reserveSum(row)}
        decimals={poolDecimals(row.data)}
      />
    ),
    header: "Reserves",
    title: "Sum of lockbox reserves",
  },
  {
    align: "right",
    cell: ({ data }) => <RelativeTime value={data.supply?.observed_at} />,
    header: "Checked",
    title: "Last supply read",
  },
]

type BridgeRow = PoolLockboxes &
  (
    | { state: Xerc20LockboxState; minter?: never }
    | {
        state?: never
        minter: Extract<Alert, { kind: "xerc20_bridge_minter" }>
      }
  )

const bridgeHealth = (row: BridgeRow): Health =>
  row.minter
    ? {
        label: "Minter",
        tone: alertTone(row.minter),
        hint: "Non-lockbox bridge can mint",
      }
    : row.state.snapshot
      ? healthy("Lockbox", "Bridge is a confirmed lockbox")
      : unavailable("Bridge classification has not completed")

const bridgeRows = (pools: PoolLockboxes[]): BridgeRow[] =>
  pools.flatMap((row) => [
    ...row.data.lockboxes.map((state) => ({ ...row, state })),
    ...(row.data.alerts ?? []).flatMap((alert) =>
      alert.kind === "xerc20_bridge_minter" ? [{ ...row, minter: alert }] : []
    ),
  ])

const mintLimit = (value?: string | null, decimals?: number | null) =>
  value == null ? (
    <Muted />
  ) : isMaxLimit(value) ? (
    <MaxLimit value={value} />
  ) : (
    <Amount value={value} decimals={decimals} />
  )

const MINTER_COLUMNS: Column<BridgeRow>[] = [
  POOL_COLUMN,
  {
    cell: (row) => (
      <AddressLink
        address={row.minter ? row.minter.bridge : row.state.lockbox}
      />
    ),
    header: "Bridge",
    title: "Bridge address",
  },
  healthColumn(bridgeHealth),
  {
    align: "right",
    cell: (row) =>
      row.minter
        ? mintLimit(row.minter.mint_limit, row.minter.decimals)
        : mintLimit(
            row.state.snapshot?.mint_limit,
            row.state.snapshot?.decimals
          ),
    header: "Mint Limit",
    title: "Max or remaining mint limit",
  },
  {
    align: "right",
    cell: (row) => <RelativeTime value={row.state?.snapshot?.observed_at} />,
    header: "Checked",
    title: "Last successful lockbox read",
  },
]

function PoolChecks() {
  const { data, error } = usePoolLockboxes()
  const lockboxes = data?.flatMap((row) =>
    row.data.lockboxes.map((state) => ({ ...row, state }))
  )
  return (
    <>
      <IssuePanel
        title="xERC20 Lockbox Depletions"
        hint="Lockbox capacity below 1% supply"
        noun="lockboxes"
        rows={lockboxes}
        classify={(row) => healthView(lockboxHealth(row).tone)}
        columns={LOCKBOX_COLUMNS}
        rowKey={({ data, state }) =>
          `${data.contract_address}:${state.lockbox}`
        }
        defaultSort={{ column: 3, descending: false }}
        issuesEmpty="No depleted lockboxes"
        error={error}
      />
      <IssuePanel
        title="xERC20 Reserve Deficits"
        hint="Supply above lockbox reserves"
        noun="pools"
        rows={data}
        classify={(row) => healthView(reserveHealth(row).tone)}
        columns={RESERVE_COLUMNS}
        rowKey={({ data }) => data.contract_address}
        defaultSort={{ column: 1, descending: false }}
        issuesEmpty="No reserve deficits"
        error={error}
      />
      <IssuePanel
        title="xERC20 Bridge Minters"
        hint="Non-lockbox bridges with mint limits"
        noun="bridges"
        rows={data && bridgeRows(data)}
        classify={(row) => healthView(bridgeHealth(row).tone)}
        columns={MINTER_COLUMNS}
        rowKey={(row) =>
          `${row.data.contract_address}:${row.minter ? row.minter.bridge : row.state.lockbox}`
        }
        defaultSort={{ column: 2, descending: false }}
        issuesEmpty="No bridge minters"
        error={error}
      />
    </>
  )
}

type BindingRow = ContractBindingState

const bindingHealth = (row: BindingRow): Health =>
  !row.bindings
    ? unavailable("No bindings check yet")
    : row.bindings.missing.length
      ? {
          label: "Mismatch",
          tone: "error",
          hint: "Code does not match used bindings",
        }
      : healthy("Match", "Code matches used bindings")

const BINDING_COLUMNS: Column<BindingRow>[] = [
  {
    cell: (row) => <AddressLink address={row.contract_address} />,
    header: "Contract",
    title: "Relay chain contract address",
  },
  healthColumn(bindingHealth),
  {
    cell: ({ bindings }) => (
      <MissingBindings missing={bindings?.missing ?? []} />
    ),
    header: "Missing",
    title: "Bindings missing from code",
  },
  {
    cell: ({ bindings }) =>
      bindings?.code_hash ? <HashText value={bindings.code_hash} /> : <Muted />,
    header: "Code",
    title: "Deployed code hash",
  },
  {
    align: "right",
    cell: ({ bindings }) => <RelativeTime value={bindings?.changed_at} />,
    header: "Changed",
    title: "Last code change seen",
    sortValue: ({ bindings }) => bindings?.changed_at,
  },
  {
    align: "right",
    cell: ({ bindings }) => <RelativeTime value={bindings?.checked_at} />,
    header: "Checked",
    title: "Last bindings check",
  },
]

function ContractBindings() {
  const { data, error } = useQuery(indexerQueries.bindings())
  return (
    <IssuePanel
      title="Contract Bindings"
      hint="Deployed code lacks used bindings"
      noun="contracts"
      rows={data?.contracts}
      classify={(row) => healthView(bindingHealth(row).tone)}
      columns={BINDING_COLUMNS}
      rowKey={(row) => row.contract_address}
      defaultSort={{ column: 1, descending: false }}
      issuesEmpty="No mismatched bindings"
      error={error}
    />
  )
}

const statusColumn = (): Column<AlertEvent> => ({
  cell: (event) => {
    const { label, tone, hint } = activityHealth(event)
    return (
      <Badge tone={tone} title={hint}>
        {label}
      </Badge>
    )
  },
  header: "Status",
  title: "Alert log status",
})

const ALERT_KINDS: Array<{ id: Alert["kind"]; name: string }> = [
  { id: "depository_deficit", name: "Hub Deficits" },
  { id: "price_stale", name: "Price Staleness" },
  { id: "price_deviation", name: "Price Deviation" },
  { id: "role_missing", name: "Contract Roles" },
  { id: "oracle_dependency", name: "Oracle Dependencies" },
  { id: "multisig_threshold", name: "Multisig Thresholds" },
  { id: "depository_admin", name: "Depository Configuration" },
  { id: "contract_address", name: "Protocol Configuration" },
  { id: "binding_mismatch", name: "Contract Bindings" },
  { id: "router_residual", name: "Router Residuals" },
  { id: "xerc20_lockbox_depleted", name: "Lockbox Depletions" },
  { id: "xerc20_reserve_deficit", name: "Reserve Deficits" },
  { id: "xerc20_bridge_minter", name: "Bridge Minters" },
]

type AlertStatus = "issue" | "inactive" | "cleared"

const ALERT_STATUSES: Array<{ label: string; value: AlertStatus }> = [
  { label: "Problem", value: "issue" },
  { label: "Inactive", value: "inactive" },
  { label: "Cleared", value: "cleared" },
]

const EVENT_COLUMNS: Column<AlertEvent>[] = [
  {
    cell: (event) => (
      <Badge title={event.alert.kind}>{eventKindLabel(event.alert.kind)}</Badge>
    ),
    header: "Alert",
    title: "Alert type",
  },
  {
    cell: (event) =>
      event.chain === HUB_CHAIN ? (
        <AddressLink address={event.deployment} />
      ) : (
        <AccountLink address={event.deployment} chain={event.chain} />
      ),
    header: "Contract",
    title: "Affected contract address",
  },
  statusColumn(),
  {
    align: "right",
    cell: (event) => formatNumber(event.count),
    header: "Count",
    title: "Alert log occurrences",
  },
  {
    cell: (event) => (
      <RelativeTime
        value={event.last_seen}
        tooltip={(now) =>
          `Started ${formatDuration(now - Date.parse(event.first_seen))} ago`
        }
      />
    ),
    header: "Seen",
    title: "Last seen",
  },
  {
    cell: (event) => (
      <FieldList
        data={event.alert}
        hidden={["kind", "severity"]}
        chain={event.chain}
      />
    ),
    header: "Details",
    title: "Alert fields",
    fill: true,
  },
]

function AlertEvents() {
  const [kind, setKind] = useState<Alert["kind"] | "">("")
  const [chain, setChain] = useState<Chain | "">("")
  const [status, setStatus] = useState<AlertStatus>("issue")
  const [page, setPage] = useState(1)
  const { data: config } = useQuery(indexerQueries.config())
  const { data, error, isPlaceholderData } = useQuery(
    indexerQueries.alerts(page, {
      kind: kind || undefined,
      chain: chain || undefined,
      active: status === "issue",
      resolved:
        status === "cleared" ? true : status === "inactive" ? false : undefined,
    })
  )
  const pageCount = Math.ceil((data?.pagination.total_items ?? 0) / PAGE_SIZE)

  return (
    <Panel
      title="Alert Logs"
      hint="History of all alerts"
      badge={
        data ? (
          <TitleCount
            label="logs"
            shown={data.pagination.total_items}
            total={data.pagination.total_items}
            filtered={false}
          />
        ) : null
      }
      actions={
        <>
          <Picker
            noun="alert"
            options={ALERT_KINDS}
            value={kind}
            label="Select alert"
            onChange={(value) => {
              setKind(value)
              setPage(1)
            }}
            onClear={() => {
              setKind("")
              setPage(1)
            }}
            variant="field"
            align="end"
            className="w-56"
          />
          <Picker
            noun="chain"
            options={chainOptions(config?.chains ?? [])}
            value={chain}
            label="All chains"
            onChange={(value) => {
              setChain(value)
              setPage(1)
            }}
            onClear={() => {
              setChain("")
              setPage(1)
            }}
            variant="field"
            align="end"
            className="w-44"
          />
          <SegmentedControl
            label="Alert status"
            options={ALERT_STATUSES}
            value={status}
            onChange={(value) => {
              setStatus(value)
              setPage(1)
            }}
          />
          <Pager
            page={page}
            pages={pageCount}
            hasPrevious={page > 1}
            hasNext={page < pageCount}
            onPrevious={() => setPage(page - 1)}
            onNext={() => setPage(page + 1)}
          />
        </>
      }
    >
      <DataTable
        columns={EVENT_COLUMNS}
        rows={data?.alerts}
        rowKey={(event) => String(event.id)}
        empty="No alert logs"
        pending={isPlaceholderData}
        error={error}
      />
    </Panel>
  )
}

const PRICE_COLUMNS: Column<PriceFeed>[] = [
  {
    cell: (feed) => <HubTokenLink tokenId={feed.token_id} />,
    header: "Token",
    title: "Token with a price route",
  },
  {
    cell: (feed) =>
      feed.status ? (
        <PriceStatusBadge
          status={feed.status}
          title={feed.error ? PRICE_ERROR_HINTS[feed.error] : undefined}
          expired={priceExpired(feed)}
        />
      ) : (
        <Muted />
      ),
    header: "Feed",
    title: "Latest oracle price status",
  },
  {
    cell: (feed) => (
      <RelativeTime value={unixTime(feed.last_price?.publish_time)} />
    ),
    header: "Published",
    title: "Oracle price publish time",
  },
  {
    cell: (feed) => formatDuration(feed.max_age_seconds * 1000),
    header: "Expiry",
    title: "Max price age",
  },
  {
    cell: (feed) => <StalenessBadge feed={feed} />,
    header: "Staleness",
    title: "Oracle price age versus expiry",
    sortValue: stalenessRank,
  },
  {
    cell: (feed) =>
      feed.deviation_bps == null ? (
        <Muted />
      ) : (
        <DeviationBadge
          value={feed.deviation_bps / 10_000}
          feed={feed}
          title="Oracle versus Relay price"
        />
      ),
    header: "Deviation",
    title: "Oracle price versus Relay price",
    sortValue: (feed) => Math.abs(feed.deviation_bps ?? 0),
  },
]

const priceView = (feed: PriceFeed): View =>
  feedAlert(feed, "price_stale") || feedAlert(feed, "price_deviation")
    ? "issues"
    : feed.status === "available" &&
        feed.last_price &&
        feed.deviation_bps != null
      ? "healthy"
      : "unknown"

function PriceOracle() {
  const { data, error } = useQuery(priceOracleQueries.feeds())
  return (
    <IssuePanel
      title="Price Oracle"
      hint="Stale or deviating oracle prices"
      noun="feeds"
      rows={data}
      classify={priceView}
      columns={PRICE_COLUMNS}
      rowKey={(feed) => feed.token_id}
      defaultSort={{ column: 4, descending: true }}
      issuesEmpty="No feed issues"
      error={error}
    />
  )
}

type CheckRow = {
  contract: string
  label: string
  actual: string
  expected?: string
  ok: boolean
  alert?: Alert
  reason?: string
}

type ContractState = {
  address: string
  configuration: ContractConfiguration
  alerts: Alert[]
  observed: string
}

const CONTRACT_FIELDS = [
  "hub",
  "allocator",
  "oracle_multisig",
  "price_oracle",
  "idempotency_store",
  "owner",
  "pending_owner",
] as const

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const isAddress = (value: string) => /^0x[0-9a-f]{40}$/i.test(value)

function Value({ value }: { value?: string }) {
  if (value == null) return <Muted />
  return isAddress(value) ? (
    <AddressLink address={value} />
  ) : (
    <span className="font-mono">{value}</span>
  )
}

const contractStates = (
  responses: Array<GetContractConfigurationResponse | undefined>
): ContractState[] => {
  const states = new Map<
    string,
    ContractConfigurationState | null | undefined
  >()
  for (const response of responses) {
    if (!response) continue
    states.set(response.contract_address, response.state)
    for (const dependency of response.dependencies) {
      states.set(dependency.address, dependency.state)
    }
  }
  return [...states].flatMap(([address, state]) =>
    state?.snapshot
      ? [
          {
            address,
            configuration: state.snapshot.configuration,
            alerts: state.alerts,
            observed: state.snapshot.observed_at,
          },
        ]
      : []
  )
}

const expectedOwner = (
  config: GetConfigResponse | undefined,
  address: string
) => {
  const protocol = config?.protocol
  if (!protocol) return undefined
  const same = (value?: string | null) =>
    value?.toLowerCase() === address.toLowerCase()
  if (same(protocol.allocator)) return protocol.owners.allocator
  if (same(protocol.price_oracle)) return protocol.owners.price_oracle
  if (same(protocol.oracle_multisig)) return protocol.owners.oracle_multisig
  return protocol.pools.find((pool) => same(pool.address))?.owner
}

const addressRows = (
  contracts: ContractState[],
  config: GetConfigResponse | undefined
): CheckRow[] =>
  contracts.flatMap(({ address, configuration, alerts }) =>
    CONTRACT_FIELDS.flatMap((field) => {
      const actual = configuration[field]
      if (!actual) return []
      const alert = alerts.find(
        (alert) => alert.kind === "contract_address" && alert.field === field
      )
      const expected =
        (alert?.kind === "contract_address" ? alert.expected : undefined) ??
        (field === "owner"
          ? expectedOwner(config, address)
          : field === "pending_owner"
            ? ZERO_ADDRESS
            : config?.protocol[field])
      return [
        {
          contract: address,
          label: eventKindLabel(field),
          actual,
          expected: expected ?? undefined,
          ok: !alert,
          alert,
        },
      ]
    })
  )

const roleRows = (contracts: ContractState[]): CheckRow[] =>
  contracts.flatMap(({ address, configuration, alerts }) =>
    configuration.roles.flatMap((role) =>
      role.members
        .filter((member) => member.required)
        .map((member) => ({
          contract: address,
          label: roleName(role.role),
          actual: member.account,
          ok: member.granted,
          alert: alerts.find(
            (alert) =>
              alert.kind === "role_missing" &&
              alert.role === role.role &&
              alert.account === member.account
          ),
        }))
    )
  )

const dependencyRows = (contracts: ContractState[]): CheckRow[] =>
  contracts.flatMap(({ address, configuration, alerts }) =>
    configuration.dependencies
      .filter((dependency) => dependency.required)
      .map((dependency) => ({
        contract: address,
        label: eventKindLabel(dependency.kind),
        actual: dependency.address,
        ok: dependency.allowed,
        alert: alerts.find(
          (alert) =>
            alert.kind === "oracle_dependency" &&
            alert.dependency === dependency.kind &&
            alert.address === dependency.address
        ),
      }))
  )

const thresholdRows = (contracts: ContractState[]): CheckRow[] =>
  contracts.flatMap(({ address, configuration, alerts }) => {
    if (!configuration.signers || !configuration.threshold) return []
    const alert = alerts.find((alert) => alert.kind === "multisig_threshold")
    return [
      {
        contract: address,
        label: "Threshold",
        actual: `${configuration.threshold} of ${configuration.signers.length}`,
        ok: !alert,
        alert,
        reason:
          alert?.kind === "multisig_threshold"
            ? alert.threshold === "0"
              ? "Threshold is zero"
              : "Threshold above signer count"
            : "Threshold within signer count",
      },
    ]
  })

function ChecksPanel({
  title,
  hint,
  header,
  valueHeader = "Current",
  expected = false,
  rows,
  loaded,
  error,
  observed,
  labels,
  hints,
}: {
  title: string
  hint: string
  header?: string
  valueHeader?: string
  expected?: boolean
  rows: CheckRow[]
  loaded: boolean
  error?: Error | null
  observed: Map<string, string>
  labels: [string, string]
  hints?: [string, string]
}) {
  const columns: Column<CheckRow>[] = [
    {
      cell: (row) => <AddressLink address={row.contract} />,
      header: "Contract",
      title: "Checked contract address",
    },
    ...(header
      ? [
          {
            cell: (row: CheckRow) => row.label,
            header,
            title:
              header === "Field"
                ? "Contract address field"
                : header === "Role"
                  ? "Required contract role"
                  : "Required Oracle dependency",
          },
        ]
      : []),
    {
      cell: (row) => (
        <Badge
          tone={row.alert ? alertTone(row.alert) : row.ok ? "success" : "error"}
          title={row.reason ?? hints?.[row.ok ? 0 : 1]}
        >
          {row.ok ? labels[0] : labels[1]}
        </Badge>
      ),
      header: "Status",
      title: "Configuration check result",
      sortValue: (row) => (row.ok ? 1 : 0),
    },
    {
      cell: (row) => <Value value={row.actual} />,
      header: valueHeader,
      title:
        valueHeader === "Threshold"
          ? "Required signatures and signer count"
          : valueHeader === "Account"
            ? "Required role account"
            : "Observed contract address",
    },
    ...(expected
      ? [
          {
            cell: (row: CheckRow) => <Value value={row.expected} />,
            header: "Expected",
            title: "Expected contract address",
          },
        ]
      : []),
    {
      cell: (row) => <RelativeTime value={observed.get(row.contract)} />,
      header: "Observed",
      title: "Configuration observation time",
    },
  ]
  return (
    <IssuePanel
      title={title}
      hint={hint}
      noun="checks"
      rows={loaded || rows.length ? rows : undefined}
      classify={(row) => (row.ok ? "healthy" : "issues")}
      columns={columns}
      rowKey={(row) => `${row.contract}:${row.label}:${row.actual}`}
      defaultSort={{
        column: columns.findIndex((column) => column.header === "Status"),
        descending: false,
      }}
      issuesEmpty="No failed checks"
      pending={!loaded && !error}
      error={error}
    />
  )
}

function useContractStates() {
  const pools = usePools()
  const queries = [
    useQuery(hubQueries.state()),
    useQuery(oracleQueries.state()),
    useQuery(allocatorQueries.state()),
    useQuery(executorQueries.state()),
    ...useQueries({
      queries: (pools.data ?? []).map((pool) =>
        xerc20Queries(pool.address).state()
      ),
    }),
  ]
  const contracts = contractStates(queries.map((query) => query.data))
  return {
    contracts,
    shared: {
      loaded: !!pools.data && queries.every((query) => query.data),
      error: pools.error ?? queries.find((query) => query.error)?.error,
      observed: new Map(
        contracts.map((contract) => [contract.address, contract.observed])
      ),
    },
  }
}

function ProtocolConfiguration() {
  const { contracts, shared } = useContractStates()
  const { data: config } = useQuery(indexerQueries.config())
  return (
    <ChecksPanel
      title="Protocol Configuration"
      hint="Wrong addresses or pending owners"
      header="Field"
      valueHeader="Address"
      expected
      rows={addressRows(contracts, config)}
      labels={["Correct", "Wrong"]}
      hints={["Address matches", "Address mismatch"]}
      {...shared}
    />
  )
}

function ContractChecks() {
  const { contracts, shared } = useContractStates()
  return (
    <>
      <ChecksPanel
        title="Contract Roles"
        hint="Accounts missing required roles"
        header="Role"
        valueHeader="Account"
        rows={roleRows(contracts)}
        labels={["Granted", "Missing"]}
        hints={["Account holds this role", "Account lacks this role"]}
        {...shared}
      />
      <ChecksPanel
        title="Oracle Dependencies"
        hint="Dependencies not approved by Oracle"
        header="Dependency"
        valueHeader="Address"
        rows={dependencyRows(contracts)}
        labels={["Approved", "Unapproved"]}
        hints={["Approved by the Oracle", "Not approved by the Oracle"]}
        {...shared}
      />
      <ChecksPanel
        title="Multisig Thresholds"
        hint="Threshold zero or above signers"
        valueHeader="Threshold"
        rows={thresholdRows(contracts)}
        labels={["Valid", "Invalid"]}
        {...shared}
      />
    </>
  )
}

type DepositoryStatus = "mismatch" | "matches" | "unavailable"

const DEPOSITORY_STATUSES = {
  mismatch: { label: "Wrong", tone: "error", order: 0 },
  matches: { label: "Correct", tone: "success", order: 1 },
  unavailable: { label: "Unavailable", tone: "neutral", order: 2 },
} as const

const CONFIGURATION_VMS = new Set(["ethereum-vm", "solana-vm"])

const ADMIN_FIELDS = {
  owner: "Owner",
  allocator: "Allocator",
  deposits_enabled: "Deposits flag",
} as const

type AdminField = keyof typeof ADMIN_FIELDS

type DepositoryRow = DepositoryDetails & {
  name: string
  status: DepositoryStatus
  reason?: string
  expectedOwner?: string | null
  expectedAllocator?: string | null
}

const depositoryRow = (
  depository: DepositoryDetails,
  chain: ChainConfigView | undefined,
  name: string
): DepositoryRow => {
  const gateway = depository.kind === "gateway_depository"
  const expectedOwner = gateway
    ? chain?.gateway_depository_owner
    : chain?.depository_owner
  const expectedAllocator = gateway
    ? chain?.gateway_depository_allocator
    : chain?.depository_allocator
  const fields = (Object.keys(ADMIN_FIELDS) as AdminField[]).filter((field) =>
    depository.alerts.some(
      (alert) => alert.kind === "depository_admin" && alert.field === field
    )
  )
  const [status, reason]: [DepositoryStatus, string?] =
    !depository.snapshot_enabled
      ? ["unavailable", "Snapshots disabled"]
      : !CONFIGURATION_VMS.has(depository.vm_type)
        ? ["unavailable", "Not supported on this chain"]
        : depository.block_number == null
          ? ["unavailable", "No snapshot yet"]
          : fields.length
            ? [
                "mismatch",
                `${fields
                  .map((field, index) =>
                    index
                      ? ADMIN_FIELDS[field].toLowerCase()
                      : ADMIN_FIELDS[field]
                  )
                  .join(" and ")} mismatch`,
              ]
            : !expectedOwner || !expectedAllocator
              ? ["unavailable", "No expected values configured"]
              : ["matches", "Owner and allocator match"]
  return {
    ...depository,
    name,
    status,
    reason,
    expectedOwner,
    expectedAllocator,
  }
}

const DEPOSITORY_COLUMNS: Column<DepositoryRow>[] = [
  {
    cell: (row) => <ChainLink chain={row.chain} />,
    header: "Chain",
    title: "Depository chain",
    sortValue: (row) => row.name,
  },
  {
    cell: (row) => (
      <span className="inline-flex items-center gap-2">
        <AccountLink address={row.address} chain={row.chain} />
        {row.kind === "gateway_depository" ? <Badge>Gateway</Badge> : null}
      </span>
    ),
    header: "Depository",
    title: "Depository address",
  },
  {
    cell: (row) => {
      const status = DEPOSITORY_STATUSES[row.status]
      return (
        <Badge
          tone={
            row.status === "mismatch" && row.alerts[0]
              ? alertTone(row.alerts[0])
              : status.tone
          }
          title={row.reason}
        >
          {status.label}
        </Badge>
      )
    },
    header: "Status",
    title: "Depository configuration check result",
    sortValue: (row) => DEPOSITORY_STATUSES[row.status].order,
  },
  {
    cell: (row) => <AccountLink address={row.owner} chain={row.chain} />,
    header: "Owner",
    title: "Observed depository owner",
  },
  {
    cell: (row) => (
      <AccountLink address={row.expectedOwner} chain={row.chain} />
    ),
    header: "Expected",
    title: "Expected owner",
  },
  {
    cell: (row) => <AccountLink address={row.allocator} chain={row.chain} />,
    header: "Allocator",
    title: "Observed depository allocator",
  },
  {
    cell: (row) => (
      <AccountLink address={row.expectedAllocator} chain={row.chain} />
    ),
    header: "Expected",
    title: "Expected allocator",
  },
  {
    cell: (row) => <RelativeTime value={row.observed_at} />,
    header: "Observed",
    title: "Configuration observation time",
  },
]

function Depositories() {
  const depositories = useQuery(chainQueries.depositories())
  const config = useQuery(indexerQueries.config())
  const labels = useLabels()
  const chains = new Map(
    config.data?.chains.map((chain) => [chain.chain, chain] as const)
  )
  const rows =
    depositories.data && config.data
      ? depositories.data.depositories
          .map((depository) =>
            depositoryRow(
              depository,
              chains.get(depository.chain),
              labels.chain(depository.chain)
            )
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
      : undefined
  return (
    <IssuePanel
      title="Depository Configuration"
      hint="Depository configuration mismatches"
      noun="depositories"
      rows={rows}
      classify={(row) => healthView(DEPOSITORY_STATUSES[row.status].tone)}
      columns={DEPOSITORY_COLUMNS}
      rowKey={(row) => `${row.chain}:${row.address}`}
      defaultSort={{ column: 2, descending: false }}
      issuesEmpty="No configuration issues"
      error={depositories.error ?? config.error}
    />
  )
}

export default function AlertsPage() {
  return (
    <>
      <Deficits />
      <PriceOracle />
      <ContractChecks />
      <Depositories />
      <ProtocolConfiguration />
      <ContractBindings />
      <RouterResiduals />
      <PoolChecks />
      <AlertEvents />
    </>
  )
}
