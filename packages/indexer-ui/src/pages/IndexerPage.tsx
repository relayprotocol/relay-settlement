import { useEffect, useRef, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError } from "../api/client"
import {
  cancelRescan,
  indexerQueries,
  PAGE_SIZE,
  RESCANS_KEY,
  submitRescan,
} from "../api/queries"
import type {
  Chain,
  ChainConfigView,
  ChainIndexingStatus,
  DatabaseTable,
  GetConfigResponse,
  GetDatabaseStatusResponse,
  GetIndexerStatusResponse,
  IndexerInstance,
  IndexerWorker,
  RescanJob,
  SnapshotDetails,
  SnapshotStatus,
  WorkerKind,
} from "../api/schema"
import {
  chainSeverity,
  chainState,
  type ChainState,
  ChainStatusBadge,
  RescanStatusBadge,
  RoleBadge,
  WorkerBadge,
} from "../components/status"
import { ChainLink } from "../components/links"
import { Picker, chainOptions, type PickerOption } from "../components/Picker"
import {
  Badge,
  Button,
  DataTable,
  FactGrid,
  KeyValuePanel,
  Muted,
  Pager,
  Panel,
  RelativeTime,
  SearchInput,
  SegmentedControl,
  TextInput,
  TitleCount,
  type Column,
} from "../components/ui"
import { Tooltip } from "../components/Tooltip"
import { useSearch } from "../search"
import {
  cx,
  formatBytes,
  formatChainName,
  formatCompact,
  formatDuration,
  formatNumber,
  plural,
  trimUrl,
} from "../utils"

type ChainSnapshot = { status: SnapshotStatus; hint: string }

type ChainRow = ChainIndexingStatus & {
  config?: ChainConfigView
  snapshot?: ChainSnapshot
}

const SNAPSHOT_STATES: Record<
  SnapshotStatus,
  {
    label: string
    tone: "success" | "warning" | "error" | "neutral"
    order: number
  }
> = {
  failed: { label: "Failed", tone: "error", order: 0 },
  stale: { label: "Stale", tone: "warning", order: 1 },
  pending: { label: "Pending", tone: "neutral", order: 2 },
  fresh: { label: "Completed", tone: "success", order: 3 },
  disabled: { label: "Disabled", tone: "neutral", order: 4 },
}

const ago = (value: string) =>
  `${formatDuration(Date.now() - Date.parse(value))} ago`

const chainSnapshot = (group: SnapshotDetails[]): ChainSnapshot => {
  const status = group.reduce<SnapshotStatus>(
    (worst, snapshot) =>
      SNAPSHOT_STATES[snapshot.status].order < SNAPSHOT_STATES[worst].order
        ? snapshot.status
        : worst,
    "fresh"
  )
  if (status === "pending") return { hint: "No snapshot collected yet", status }
  const items = plural(group.length, "item")
  if (status === "fresh") {
    const oldest = group
      .flatMap((snapshot) => snapshot.last_success_at ?? [])
      .sort()[0]
    const completed = `${items} completed`
    return { hint: oldest ? `${completed} ${ago(oldest)}` : completed, status }
  }
  const affected = group.filter((snapshot) => snapshot.status === status)
  const latest = affected
    .flatMap(
      (snapshot) =>
        (status === "failed"
          ? snapshot.last_attempt_at
          : snapshot.last_success_at) ?? []
    )
    .sort()
    .at(-1)
  const summary = `${affected.length} of ${items} ${status}`
  return { hint: latest ? `${summary} ${ago(latest)}` : summary, status }
}

const chainSnapshots = (snapshots: SnapshotDetails[]) => {
  const groups = new Map<Chain, SnapshotDetails[]>()
  for (const snapshot of snapshots) {
    if (snapshot.status === "disabled") continue
    groups.set(snapshot.chain, [
      ...(groups.get(snapshot.chain) ?? []),
      snapshot,
    ])
  }
  return new Map(
    [...groups].map(([chain, group]) => [chain, chainSnapshot(group)])
  )
}

type ChainFilter = "all" | ChainState

const CHAIN_FILTERS: Array<{ label: string; value: ChainFilter }> = [
  { label: "All", value: "all" },
  { label: "Synced", value: "synced" },
  { label: "Processing", value: "processing" },
  { label: "Initializing", value: "initializing" },
  { label: "Restarting", value: "restarting" },
  { label: "Stopped", value: "stopped" },
  { label: "Disabled", value: "disabled" },
]

const chainName = (row: ChainRow) =>
  formatChainName(row.config?.name ?? row.chain)

const orDash = (
  value: number | null | undefined,
  format: (value: number) => string
) => (value == null ? <Muted /> : format(value))

const CHAIN_COLUMNS: Column<ChainRow>[] = [
  {
    cell: (row) => <ChainLink chain={row.chain} />,
    header: "Chain",
    title: "Indexed chain",
    sortValue: chainName,
  },
  {
    cell: (row) => <ChainStatusBadge status={row} />,
    header: "Status",
    title: "Chain indexer status",
    sortValue: (row) => chainSeverity(row),
  },
  {
    align: "right",
    cell: (row) => orDash(row.head_block, formatNumber),
    header: "Head",
    title: "Followed chain head",
    sortValue: (row) => row.head_block,
  },
  {
    align: "right",
    cell: (row) => orDash(row.history_start, formatNumber),
    header: "Start",
    title: "First indexed block",
    sortValue: (row) => row.history_start,
  },
  {
    align: "right",
    cell: (row) => <RelativeTime value={row.head_advanced_at} />,
    header: "Updated",
    title: "Head last advanced",
    sortValue: (row) =>
      row.head_advanced_at ? Date.parse(row.head_advanced_at) : null,
  },
  {
    align: "right",
    cell: (row) => formatNumber(row.failed_blocks),
    header: "Failed blocks",
    title: "Unresolved failed blocks",
    sortValue: (row) => row.failed_blocks,
  },
  {
    align: "right",
    cell: (row) => orDash(row.reorgs, formatNumber),
    header: "Reorgs",
    title: "Segments replaced by reorgs",
    sortValue: (row) => row.reorgs,
  },
  {
    cell: ({ config, snapshot }) =>
      snapshot ? (
        <Badge
          tone={SNAPSHOT_STATES[snapshot.status].tone}
          title={snapshot.hint}
        >
          {SNAPSHOT_STATES[snapshot.status].label}
        </Badge>
      ) : config?.snapshot_enabled ? (
        <Badge tone="neutral" title="No snapshot collected yet">
          Pending
        </Badge>
      ) : (
        <Muted />
      ),
    header: "Snapshot",
    title: "State snapshot status",
    sortValue: ({ config, snapshot }) =>
      snapshot
        ? SNAPSHOT_STATES[snapshot.status].order
        : config?.snapshot_enabled
          ? SNAPSHOT_STATES.pending.order
          : null,
  },
]

function Chains({
  config,
  status,
  error,
}: {
  config?: GetConfigResponse
  status?: GetIndexerStatusResponse
  error?: Error | null
}) {
  const [filter, setFilter] = useState<ChainFilter>("all")
  const search = useSearch()
  const configs = new Map(config?.chains.map((chain) => [chain.chain, chain]))
  const { data: snapshots } = useQuery(indexerQueries.snapshots())
  const snapshotsByChain = chainSnapshots(snapshots?.snapshots ?? [])
  const rows = status?.chains.map((chain) => ({
    ...chain,
    config: configs.get(chain.chain),
    snapshot: snapshotsByChain.get(chain.chain),
  }))
  const query = search.query.toLowerCase()
  const visible = rows?.filter(
    (row) =>
      (filter === "all" || chainState(row) === filter) &&
      (!query ||
        row.chain.includes(query) ||
        row.config?.name.toLowerCase().includes(query))
  )

  return (
    <Panel
      title="Chains"
      badge={
        rows && visible ? (
          <TitleCount
            label="chains"
            shown={visible.length}
            total={rows.length}
            filtered={filter !== "all" || !!query}
          />
        ) : null
      }
      actions={
        <>
          <SegmentedControl
            label="Chain status"
            options={CHAIN_FILTERS}
            value={filter}
            onChange={setFilter}
          />
          <SearchInput placeholder="Search chains" {...search.input} />
        </>
      }
    >
      <DataTable
        columns={CHAIN_COLUMNS}
        rows={visible}
        rowKey={(row) => row.chain}
        defaultSort={{ column: 0, descending: false }}
        empty="No chains"
        error={error}
      />
    </Panel>
  )
}

const BLOCK = /^\d+$/

const progress = (job: RescanJob) =>
  Math.floor((job.processed_blocks / (job.to_block - job.from_block + 1)) * 100)

const CONFIRM_TIMEOUT_MS = 3000

const CONFIRM =
  "cursor-pointer text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary-fg focus-visible:ring-inset"

function CancelRescan({ id }: { id: string }) {
  const queryClient = useQueryClient()
  const group = useRef<HTMLSpanElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [restoreFocus, setRestoreFocus] = useState(false)
  const cancel = useMutation({
    mutationFn: () => cancelRescan(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: RESCANS_KEY }),
  })

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => {
      setRestoreFocus(group.current?.contains(document.activeElement) ?? false)
      setConfirming(false)
    }, CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  if (confirming)
    return (
      <span
        ref={group}
        role="group"
        aria-label={`Confirm cancel of rescan ${id}`}
        className="inline-grid h-8 w-24 grid-cols-2 overflow-hidden rounded-md align-middle"
      >
        <Tooltip content="Cancel this rescan">
          <button
            type="button"
            onClick={() => {
              setRestoreFocus(true)
              setConfirming(false)
              cancel.mutate()
            }}
            className={cx(
              CONFIRM,
              "bg-success-bg text-success-fg hover:bg-(--grass-4) active:bg-(--grass-5)"
            )}
          >
            Yes
          </button>
        </Tooltip>
        <Tooltip content="Keep this rescan">
          <button
            type="button"
            autoFocus
            onClick={() => {
              setRestoreFocus(true)
              setConfirming(false)
            }}
            className={cx(
              CONFIRM,
              "bg-error-bg text-error-fg hover:bg-(--tomato-4) active:bg-(--tomato-5)"
            )}
          >
            No
          </button>
        </Tooltip>
      </span>
    )

  return (
    <Tooltip
      content={cancel.isError ? "Cancel request failed" : "Stop this rescan"}
    >
      <Button
        variant="neutral"
        aria-label={`Cancel rescan ${id}`}
        autoFocus={restoreFocus}
        disabled={cancel.isPending}
        onClick={() => setConfirming(true)}
        className="w-24"
      >
        {cancel.isPending ? "Cancelling..." : "Cancel"}
      </Button>
    </Tooltip>
  )
}

const RESCAN_COLUMNS: Column<RescanJob>[] = [
  {
    cell: (job) => <ChainLink chain={job.chain} />,
    header: "Chain",
    title: "Rescan chain",
  },
  {
    cell: (job) => (
      <span className="tabular-nums">{formatNumber(job.from_block)}</span>
    ),
    header: "From",
    title: "First rescanned block",
  },
  {
    cell: (job) => (
      <span className="tabular-nums">{formatNumber(job.to_block)}</span>
    ),
    header: "To",
    title: "Last rescanned block",
  },
  {
    cell: (job) => (
      <RescanStatusBadge
        status={job.status}
        progress={job.status === "running" ? progress(job) : undefined}
        error={job.error}
      />
    ),
    header: "Status",
    title: "Rescan status and progress",
  },
  {
    align: "right",
    cell: (job) => formatNumber(job.to_block - job.from_block + 1),
    header: "Blocks",
    title: "Blocks in rescan range",
  },
  {
    align: "right",
    cell: (job) => formatNumber(job.inserted_events),
    header: "Inserted",
    title: "Events inserted during rescan",
  },
  {
    align: "right",
    cell: (job) => formatNumber(job.removed_events),
    header: "Removed",
    title: "Events removed during rescan",
  },
  {
    align: "right",
    cell: (job) => <RelativeTime value={job.created_at} />,
    header: "Created",
    title: "Rescan creation time",
  },
]

const cancellable = (job: RescanJob) =>
  job.status === "pending" || job.status === "running"

const CANCEL_COLUMN: Column<RescanJob> = {
  cell: (job) => (cancellable(job) ? <CancelRescan id={job.id} /> : null),
  fit: true,
  header: <span className="sr-only">Actions</span>,
  title: "Rescan actions",
}

function RescanForm({
  chains,
  starts,
  maxBlocks,
  onSubmitted,
}: {
  chains: PickerOption<Chain>[]
  starts: Map<Chain, number | null | undefined>
  maxBlocks: number
  onSubmitted: () => void
}) {
  const queryClient = useQueryClient()
  const [chain, setChain] = useState(chains[0]?.id)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [attempted, setAttempted] = useState(false)
  const submit = useMutation({
    mutationFn: submitRescan,
    onSuccess: () => {
      setFrom("")
      setTo("")
      setAttempted(false)
      onSubmitted()
      return queryClient.invalidateQueries({ queryKey: RESCANS_KEY })
    },
  })
  const start = chain && starts.get(chain)
  const fromInvalid = from !== "" && !BLOCK.test(from)
  const toInvalid = to !== "" && !BLOCK.test(to)
  const complete = BLOCK.test(from) && BLOCK.test(to)
  const fromMissing = attempted && from === ""
  const toMissing = attempted && to === ""
  const beforeStart = BLOCK.test(from) && start != null && Number(from) < start
  const reversed = complete && Number(to) < Number(from)
  const tooLarge = complete && Number(to) - Number(from) >= maxBlocks
  const problem =
    fromInvalid || toInvalid
      ? "Block numbers must be whole numbers"
      : fromMissing || toMissing
        ? "Enter the from and to blocks"
        : beforeStart
          ? `From block must be at or after the history start (${start})`
          : reversed
            ? "To block must be at or after from block"
            : tooLarge
              ? `A rescan can cover at most ${formatNumber(maxBlocks)} blocks`
              : undefined
  const error =
    problem ??
    (submit.error instanceof ApiError
      ? (submit.error.detail ?? submit.error.message)
      : submit.error?.message)

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (!chain || !complete || problem) return
    submit.mutate({ chain, from_block: Number(from), to_block: Number(to) })
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-2 border-b border-line px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {chain ? (
          <Picker
            noun="chain"
            options={chains}
            value={chain}
            label="Chain"
            onChange={(next) => {
              if (next) setChain(next)
            }}
            variant="field"
            className="w-44"
          />
        ) : null}
        <TextInput
          aria-label="From"
          placeholder="From"
          inputMode="numeric"
          value={from}
          invalid={fromInvalid || fromMissing || beforeStart}
          onChange={(event) => setFrom(event.target.value.trim())}
          className="w-36"
        />
        <TextInput
          aria-label="To"
          placeholder="To"
          inputMode="numeric"
          value={to}
          invalid={toInvalid || toMissing || reversed || tooLarge}
          onChange={(event) => setTo(event.target.value.trim())}
          className="w-36"
        />
        <Button
          type="submit"
          variant="neutral"
          className="min-w-20"
          disabled={submit.isPending}
        >
          {submit.isPending ? "Submitting..." : "Submit"}
        </Button>
      </div>
      {error ? <p className="text-xs text-error-fg">{error}</p> : null}
    </form>
  )
}

function Rescans({
  config,
  status,
}: {
  config?: GetConfigResponse
  status?: GetIndexerStatusResponse
}) {
  const [page, setPage] = useState(1)
  const { data, error, isPlaceholderData } = useQuery(
    indexerQueries.rescans(page)
  )
  const pageCount = Math.ceil((data?.pagination.total_items ?? 0) / PAGE_SIZE)
  const starts = new Map(
    status?.chains.map((chain) => [chain.chain, chain.history_start])
  )
  const chains = chainOptions(
    (config?.chains ?? []).filter((chain) => chain.indexer_enabled)
  )

  return (
    <Panel
      title="Rescans"
      actions={
        <Pager
          page={page}
          pages={pageCount}
          hasPrevious={page > 1}
          hasNext={page < pageCount}
          onPrevious={() => setPage(page - 1)}
          onNext={() => setPage(page + 1)}
        />
      }
    >
      {config ? (
        <RescanForm
          chains={chains}
          starts={starts}
          maxBlocks={config.service.rescan_max_blocks}
          onSubmitted={() => setPage(1)}
        />
      ) : null}
      <DataTable
        columns={
          data?.rescans.some(cancellable)
            ? [...RESCAN_COLUMNS, CANCEL_COLUMN]
            : RESCAN_COLUMNS
        }
        rows={data?.rescans}
        rowKey={(job) => job.id}
        empty="No manual rescans"
        pending={isPlaceholderData}
        error={error}
      />
    </Panel>
  )
}

const TABLE_COLUMNS: Column<DatabaseTable>[] = [
  {
    cell: (table) => <span className="font-mono">{table.name}</span>,
    header: "Table",
    title: "Database table name",
    sortValue: (table) => table.name,
  },
  {
    align: "right",
    cell: (table) => (
      <Tooltip content={formatNumber(table.live_rows)}>
        <span>{formatCompact(table.live_rows)}</span>
      </Tooltip>
    ),
    header: "Rows",
    title: "Estimated row count",
    sortValue: (table) => table.live_rows,
  },
  {
    align: "right",
    cell: (table) => formatBytes(table.table_bytes),
    header: "Data",
    title: "Table data size",
    sortValue: (table) => table.table_bytes,
  },
  {
    align: "right",
    cell: (table) => formatBytes(table.index_bytes),
    header: "Indexes",
    title: "Index size",
    sortValue: (table) => table.index_bytes,
  },
  {
    align: "right",
    cell: (table) => formatBytes(table.total_bytes),
    header: "Total",
    title: "Total disk size",
    sortValue: (table) => table.total_bytes,
  },
]

const sum = <T,>(items: T[], value: (item: T) => number) =>
  items.reduce((total, item) => total + value(item), 0)

function Database({
  database,
  error,
}: {
  database?: GetDatabaseStatusResponse
  error?: Error | null
}) {
  return (
    <Panel title="Database">
      {database ? (
        <div className="border-b border-line">
          <FactGrid
            size="lg"
            items={[
              { label: "Type", value: "Postgres" },
              { label: "Version", value: database.server.version },
              {
                label: "Total",
                value: formatBytes(
                  sum(database.tables, (table) => table.total_bytes)
                ),
              },
              {
                label: "Indexes",
                value: formatBytes(
                  sum(database.tables, (table) => table.index_bytes)
                ),
              },
              {
                label: "Pool",
                value: formatNumber(
                  database.pool.max_connections * database.pool.instances.length
                ),
              },
              {
                label: "Connections",
                value: formatNumber(
                  sum(database.pool.instances, (pool) => pool.connections)
                ),
              },
              {
                label: "Migrations",
                value: formatNumber(database.migrations.applied),
              },
            ]}
          />
        </div>
      ) : null}
      <DataTable
        columns={TABLE_COLUMNS}
        rows={database?.tables.filter(
          (table) => table.name !== "_sqlx_migrations"
        )}
        rowKey={(table) => table.name}
        defaultSort={{ column: 4, descending: true }}
        error={error}
      />
    </Panel>
  )
}

const WORKERS: Record<WorkerKind, { label: string; hint: string }> = {
  balance_snapshots: {
    label: "Balance snapshots",
    hint: "Collects balances and checks deficits",
  },
  balances: { label: "Hub balances", hint: "Refreshes Hub token balances" },
  configuration_snapshots: {
    label: "Configuration snapshots",
    hint: "Collects contract configuration",
  },
  database_indexes: {
    label: "Database indexes",
    hint: "Builds and drops database indexes",
  },
  lockbox_snapshots: {
    label: "Lockbox snapshots",
    hint: "Collects xERC20 lockbox state",
  },
  oracle_peer_snapshots: {
    label: "Oracle peer snapshots",
    hint: "Polls oracle service peers",
  },
  price_oracle_snapshots: {
    label: "Price oracle snapshots",
    hint: "Collects price oracle state",
  },
  prices: { label: "Relay prices", hint: "Fetches Relay token prices" },
  rescans: { label: "Rescans", hint: "Runs rescans and retries failures" },
  router_snapshots: {
    label: "Router snapshots",
    hint: "Collects router balances",
  },
  status: { label: "Status heartbeat", hint: "Logs the indexer heartbeat" },
  token_metadata: {
    label: "Token metadata",
    hint: "Refreshes Hub token metadata",
  },
  transfer_statistics: {
    label: "Transfer statistics",
    hint: "Backfills hourly transfer statistics",
  },
}

const INSTANCE_COLUMNS: Column<IndexerInstance>[] = [
  {
    cell: (instance) => <span className="font-mono">{instance.id}</span>,
    header: "Instance",
    title: "Indexer instance ID",
  },
  {
    cell: (instance) => <RoleBadge role={instance.role} />,
    header: "Role",
    title: "Indexer instance role",
  },
  {
    cell: (instance) => instance.version,
    header: "Version",
    title: "Indexer software version",
  },
  {
    align: "right",
    cell: (instance) => <RelativeTime value={instance.started_at} />,
    header: "Started",
    title: "Instance start time",
  },
]

const WORKER_COLUMNS: Column<IndexerWorker>[] = [
  {
    cell: (worker) => (
      <Tooltip content={WORKERS[worker.kind].hint}>
        <span>{WORKERS[worker.kind].label}</span>
      </Tooltip>
    ),
    header: "Worker",
    title: "Background worker task",
  },
  {
    cell: (worker) => <WorkerBadge worker={worker.worker} />,
    header: "Status",
    title: "Worker activity status",
  },
  {
    cell: (worker) => {
      const run = workerRun(worker)
      return (
        <Badge tone={RUN_STATES[run.state].tone} title={run.hint}>
          {RUN_STATES[run.state].label}
        </Badge>
      )
    },
    header: "Result",
    title: "Last pass result",
    sortValue: (worker) => RUN_STATES[workerRun(worker).state].order,
  },
  {
    align: "right",
    cell: ({ interval_sec }) =>
      interval_sec == null ? <Muted /> : formatDuration(interval_sec * 1000),
    header: "Interval",
    title: "Time between passes",
    sortValue: (worker) => worker.interval_sec,
  },
  {
    align: "right",
    cell: ({ completed_at, started_at }) => {
      if (!completed_at) return <Muted />
      const duration = started_at
        ? Date.parse(completed_at) - Date.parse(started_at)
        : null
      return (
        <RelativeTime
          value={completed_at}
          hint={
            duration != null && duration >= 0
              ? `Took ${formatDuration(duration)}`
              : undefined
          }
        />
      )
    },
    header: "Finished",
    title: "Last pass finished",
    sortValue: (worker) =>
      worker.completed_at ? Date.parse(worker.completed_at) : null,
  },
]

type RunState =
  | "failed"
  | "partial"
  | "running"
  | "pending"
  | "idle"
  | "success"

const RUN_STATES: Record<
  RunState,
  {
    label: string
    tone: "success" | "warning" | "error" | "neutral" | "primary"
    order: number
  }
> = {
  failed: { label: "Failed", tone: "error", order: 0 },
  partial: { label: "Partial", tone: "warning", order: 1 },
  running: { label: "Running", tone: "primary", order: 2 },
  pending: { label: "Pending", tone: "neutral", order: 3 },
  idle: { label: "Idle", tone: "neutral", order: 4 },
  success: { label: "Completed", tone: "success", order: 5 },
}

const workerRun = (
  worker: IndexerWorker
): { state: RunState; hint: string } => {
  const { completed_at, error, failed, interval_sec, started_at, succeeded } =
    worker
  if (!started_at && !completed_at)
    return interval_sec == null
      ? { hint: "No work since restart", state: "idle" }
      : { hint: "No pass completed yet", state: "pending" }
  if (
    started_at &&
    (!completed_at || Date.parse(completed_at) < Date.parse(started_at))
  )
    return { hint: `Started ${ago(started_at)}`, state: "running" }
  if (error && !succeeded) return { hint: error, state: "failed" }
  const total = (succeeded ?? 0) + (failed ?? 0)
  const hint = failed
    ? `${formatNumber(failed)} of ${plural(total, "item")} failed`
    : error
      ? error
      : succeeded == null
        ? "Last pass completed"
        : `${plural(succeeded, "item")} completed`
  return { hint, state: failed || error ? "partial" : "success" }
}

function Service({
  status,
  error,
}: {
  status?: GetIndexerStatusResponse
  error?: Error | null
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Instances">
        <DataTable
          columns={INSTANCE_COLUMNS}
          rows={status?.instances}
          rowKey={(instance) => instance.id}
          empty="No active instances"
          error={error}
        />
      </Panel>
      <Panel title="Workers">
        <DataTable
          columns={WORKER_COLUMNS}
          rows={status?.workers}
          rowKey={(worker) => worker.kind}
          defaultSort={{ column: 2, descending: false }}
          error={error}
        />
      </Panel>
    </div>
  )
}

const configEntries = (
  value: object,
  prefix = ""
): Array<{ label: string; value?: string }> =>
  Object.entries(value).flatMap(([key, item]: [string, unknown]) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? configEntries(item, `${prefix}${key}_`)
      : {
          label: `${prefix}${key}`,
          value:
            item == null
              ? undefined
              : trimUrl(
                  (Array.isArray(item)
                    ? JSON.stringify(item)
                    : String(item)
                  ).replace(/\{\{(\w+)\}\}/g, "$1")
                ),
        }
  )

export default function IndexerPage() {
  const status = useQuery(indexerQueries.status())
  const config = useQuery(indexerQueries.config())
  const database = useQuery(indexerQueries.database())

  return (
    <>
      <Service status={status.data} error={status.error} />
      <Chains config={config.data} status={status.data} error={status.error} />
      <Rescans config={config.data} status={status.data} />
      <Database database={database.data} error={database.error} />
      <KeyValuePanel
        items={config.data && configEntries(config.data.service)}
        error={config.error}
      />
    </>
  )
}
