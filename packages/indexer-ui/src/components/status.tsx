import type {
  Alert,
  ChainIndexingStatus,
  DeficitCheck,
  DeficitError,
  DeficitStatus,
  PriceFeed,
  PriceSnapshotError,
  PriceStatus,
  ReplicaRole,
  RescanStatus,
  SnapshotError,
  WorkerStatus,
} from "../api/schema"
import {
  capitalize,
  formatDeviation,
  formatDuration,
  formatPercent,
} from "../utils"
import { Badge, Muted } from "./ui"

export const alertTone = (alert: Alert) =>
  alert.severity === "warn" ? "warning" : "error"

const WORKER_TONES = {
  active: "success",
  disabled: "neutral",
  initializing: "primary",
  restarting: "error",
  stopped: "error",
} as const

const WORKER_HINTS: Record<WorkerStatus, string> = {
  active: "Worker is running",
  disabled: "Disabled in the configuration",
  initializing: "Worker is starting",
  restarting: "Retrying after a failure",
  stopped: "Worker stopped reporting",
}

export function WorkerBadge({ worker }: { worker: WorkerStatus }) {
  return (
    <Badge tone={WORKER_TONES[worker]} title={WORKER_HINTS[worker]}>
      {capitalize(worker)}
    </Badge>
  )
}

const CHAIN_STATE_TONES = {
  disabled: "neutral",
  initializing: "primary",
  processing: "warning",
  restarting: "error",
  stopped: "error",
  synced: "success",
} as const

export type ChainState = keyof typeof CHAIN_STATE_TONES

const CHAIN_STATE_HINTS: Record<ChainState, string> = {
  disabled: "Disabled in the configuration",
  initializing: "Indexer is starting",
  processing: "Catching up to chain head",
  restarting: "Retrying after a failure",
  stopped: "Indexer stopped reporting",
  synced: "At the chain head",
}

const CHAIN_STATE_ORDER: ChainState[] = [
  "restarting",
  "stopped",
  "processing",
  "initializing",
  "synced",
  "disabled",
]

export const chainState = ({
  synced,
  worker,
}: ChainIndexingStatus): ChainState =>
  worker === "active" ? (synced ? "synced" : "processing") : worker

export const chainSeverity = (status: ChainIndexingStatus) =>
  CHAIN_STATE_ORDER.indexOf(chainState(status))

export function ChainStatusBadge({ status }: { status: ChainIndexingStatus }) {
  const state = chainState(status)
  return (
    <Badge
      tone={CHAIN_STATE_TONES[state]}
      title={
        status.restart
          ? capitalize(status.restart.reason)
          : CHAIN_STATE_HINTS[state]
      }
    >
      {capitalize(state)}
    </Badge>
  )
}

const ROLE_HINTS: Record<ReplicaRole, string> = {
  reader: "Serves the API only",
  writer: "Indexes chains into the database",
}

export function RoleBadge({ role }: { role: ReplicaRole }) {
  return (
    <Badge
      tone={role === "writer" ? "primary" : "neutral"}
      title={ROLE_HINTS[role]}
    >
      {capitalize(role)}
    </Badge>
  )
}

const RESCAN_STATUS_TONES = {
  cancelled: "neutral",
  completed: "success",
  failed: "error",
  pending: "neutral",
  running: "primary",
} as const

const RESCAN_STATUS_HINTS: Record<RescanStatus, string> = {
  cancelled: "Rescan was cancelled",
  completed: "Rescan finished",
  failed: "Rescan failed",
  pending: "Rescan is waiting to start",
  running: "Rescan is in progress",
}

export function RescanStatusBadge({
  status,
  progress,
  error,
}: {
  status: RescanStatus
  progress?: number
  error?: string | null
}) {
  return (
    <Badge
      tone={RESCAN_STATUS_TONES[status]}
      title={error ? capitalize(error) : RESCAN_STATUS_HINTS[status]}
    >
      {capitalize(status)}
      {progress == null ? null : (
        <span className="ml-1 tabular-nums">{progress}%</span>
      )}
    </Badge>
  )
}

export const PRICE_STATUS_TONES = {
  available: "success",
  error: "error",
  stale: "warning",
  unavailable: "warning",
  unsupported: "neutral",
} as const

export const priceExpired = (feed: PriceFeed) =>
  feed.status === "unavailable" && feed.error === "expired"

export function PriceStatusBadge({
  status,
  title,
  expired,
}: {
  status: PriceStatus
  title?: string
  expired?: boolean
}) {
  return (
    <Badge
      tone={PRICE_STATUS_TONES[status]}
      title={expired ? "Price older than expiry" : title}
    >
      {expired ? "Expired" : capitalize(status)}
    </Badge>
  )
}

export const feedAlert = <K extends Alert["kind"]>(feed: PriceFeed, kind: K) =>
  feed.alerts.find(
    (alert): alert is Extract<Alert, { kind: K }> => alert.kind === kind
  )

export const stalenessRank = (feed?: PriceFeed) =>
  feed?.last_price ? (feedAlert(feed, "price_stale") ? 1 : 0) : undefined

export function StalenessBadge({ feed }: { feed?: PriceFeed }) {
  if (!feed?.last_price) return <Muted />
  const stale = feedAlert(feed, "price_stale")
  return stale ? (
    <Badge
      tone={alertTone(stale)}
      title={`Published ${formatDuration(stale.age_seconds * 1000)} ago`}
    >
      Stale
    </Badge>
  ) : (
    <Badge tone="success" title="Price within expiry">
      Fresh
    </Badge>
  )
}

export function DeviationBadge({
  value,
  feed,
  title,
}: {
  value: number
  feed?: PriceFeed
  title: string
}) {
  const alert = feed && feedAlert(feed, "price_deviation")
  return (
    <Badge
      tone={alert ? alertTone(alert) : "success"}
      title={
        alert
          ? `Threshold ${formatPercent(alert.threshold_bps / 10_000)}`
          : title
      }
    >
      {formatDeviation(value)}
    </Badge>
  )
}

const DEFICIT_STATUSES: Record<
  DeficitStatus,
  {
    label: string
    tone: "error" | "warning" | "muted" | "success"
    hint: string
  }
> = {
  confirmed: {
    label: "Confirmed",
    tone: "error",
    hint: "Deficit persisted across consecutive checks",
  },
  unconfirmed: {
    label: "Unconfirmed",
    tone: "warning",
    hint: "Deficit awaiting confirmation",
  },
  sufficient: {
    label: "Sufficient",
    tone: "success",
    hint: "Depository balance covers Hub supply",
  },
  unavailable: {
    label: "Unavailable",
    tone: "muted",
    hint: "Balances could not be compared",
  },
}

export const DEFICIT_STATUS_ORDER: DeficitStatus[] = [
  "confirmed",
  "unconfirmed",
  "sufficient",
  "unavailable",
]

export const SNAPSHOT_ERROR_HINTS: Record<SnapshotError, string> = {
  decimals_mismatch: "Decimals differ from Hub",
  disabled: "Snapshots are disabled",
  invalid_account: "Invalid token account",
  invalid_asset: "Invalid asset address",
  invalid_response: "Invalid RPC response",
  missing_bindings: "Bindings missing from deployed code",
  missing_depository: "Depository not configured",
  missing_metadata: "Incomplete token metadata",
  not_indexed: "History not indexed yet",
  rpc_failure: "RPC request failed",
  stale_block: "Snapshot block not advancing",
  unknown_chain: "Unknown origin chain",
  unsupported_extension: "Unsupported token extension",
}

export const PRICE_ERROR_HINTS: Record<PriceSnapshotError, string> = {
  expired: "Price older than expiry",
  feed_unavailable: "Feed is unavailable",
  future_timestamp: "Publish time in future",
  invalid_response: "Invalid RPC response",
  rpc_failure: "RPC request failed",
  timestamp_rollback: "Publish time went back",
}

const DEFICIT_ERROR_HINTS: Record<
  Exclude<DeficitError["kind"], "depository">,
  string
> = {
  disabled: "Deficit checks are disabled",
  facade_incomplete: "Facade balance incomplete",
  hub_unavailable: "Hub supply unavailable",
  invalid_amount: "Invalid balance amount",
  mapping_changed: "Token mapping changed",
  missing_snapshot: "No depository snapshot",
  stale: "Snapshot is too old",
}

const deficitReason = (error?: DeficitError | null) =>
  error
    ? "reason" in error
      ? SNAPSHOT_ERROR_HINTS[error.reason]
      : DEFICIT_ERROR_HINTS[error.kind]
    : undefined

export function DeficitStatusBadge({ check }: { check: DeficitCheck }) {
  const status = DEFICIT_STATUSES[check.status]
  return (
    <Badge tone={status.tone} title={deficitReason(check.error) ?? status.hint}>
      {status.label}
    </Badge>
  )
}
