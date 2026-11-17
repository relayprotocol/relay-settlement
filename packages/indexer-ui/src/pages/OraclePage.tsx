import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { oracleQueries } from "../api/queries"
import type {
  IndexedContractEvent,
  IndexedOracleExecution,
  OracleAction,
  OracleDependency,
  OraclePeerCheck,
  OraclePeerError,
  OraclePeerState,
  RateLimitConfiguration,
} from "../api/schema"
import {
  addressItem,
  ConfigurationPanel,
  dependency,
  RolesPanel,
} from "../components/contract"
import { eventColumns, EventPanel, TokenAmount } from "../components/events"
import { Picker } from "../components/Picker"
import { TRANSFER_KIND_TONES } from "../components/transfers"
import {
  AddressLink,
  ChainLink,
  CopyOverlay,
  HashText,
  TxLink,
} from "../components/links"
import {
  CursorPager,
  ListPager,
  useCursorPages,
  useListPages,
} from "../components/pagination"
import { UsdAmount, UsdValue } from "../components/Usd"
import {
  Badge,
  CollapsedList,
  DataTable,
  Muted,
  Panel,
  RelativeTime,
  SegmentedControl,
  TitleCount,
  type Column,
} from "../components/ui"
import { Tooltip } from "../components/Tooltip"
import { useNow } from "../now"
import { useTokens } from "../tokens"
import { formatNumber, plural, shortAddress } from "../utils"

const ORACLE_EVENT_KINDS = [
  "fee_calculator_added",
  "fee_calculator_removed",
  "rate_limiter_added",
  "rate_limiter_removed",
  "bucket_config_set",
  "tokens_consumed",
  "source_added",
  "source_removed",
  "signer_added",
  "signer_removed",
  "threshold_changed",
  "ownership_transfer_started",
  "ownership_transferred",
]

const DAY = 86_400_000
const PEER_MAX_AGE = 10 * 60_000

const PEER_ERRORS: Record<OraclePeerError, string> = {
  invalid_response: "Invalid oracle service response",
  timeout: "Oracle service timed out",
  unauthorized: "Oracle service rejected API key",
  unreachable: "Configured oracle service unreachable",
}

const PEER_CHECKS: Record<OraclePeerCheck, string> = {
  authentication_error: "Authentication failed",
  cancelled: "Check cancelled",
  http_error: "HTTP error",
  invalid_response: "Invalid response",
  invalid_url: "Invalid URL",
  network_error: "Network error",
  response_too_large: "Response too large",
  success: "Check succeeded",
  timeout: "Check timed out",
  unsupported_endpoint: "Unsupported endpoint",
}

type SignerRow = {
  key: string
  signer?: string | null
  configured: boolean
  peer?: OraclePeerState
}

const signerRows = (
  signers: string[],
  peers: OraclePeerState[]
): SignerRow[] => {
  const signerOf = (peer: OraclePeerState) =>
    peer.snapshot?.signer?.toLowerCase()
  const configured = new Set(signers.map((signer) => signer.toLowerCase()))
  return [
    ...signers.map((signer) => ({
      configured: true,
      key: signer,
      peer: peers.find((peer) => signerOf(peer) === signer.toLowerCase()),
      signer,
    })),
    ...peers
      .filter((peer) => !configured.has(signerOf(peer) ?? ""))
      .map((peer) => ({
        configured: false,
        key: peer.url,
        peer,
        signer: peer.snapshot?.signer,
      })),
  ]
}

function PeerStatus({ peer }: { peer?: OraclePeerState }) {
  const snapshot = peer?.snapshot
  if (!snapshot)
    return <Badge title="Not reported by oracle service">Unknown</Badge>
  if (snapshot.check_result && snapshot.check_result !== "success")
    return (
      <Badge tone="error" title={PEER_CHECKS[snapshot.check_result]}>
        Unreachable
      </Badge>
    )
  if (snapshot.status === "partial")
    return (
      <Badge tone="warning" title="Oracle reports partial status">
        Partial
      </Badge>
    )
  return (
    <Badge
      tone="success"
      title={
        peer.queried
          ? `Queried oracle with ${plural(snapshot.peer_count ?? 0, "peer")}`
          : "Peer check succeeded"
      }
    >
      Live
    </Badge>
  )
}

const peerHost = (url: string) => url.replace(/^[a-z]+:\/\//i, "").split("/")[0]

const PEER_COLUMN: Column<SignerRow> = {
  cell: (row) =>
    row.peer?.url ? (
      <Tooltip content={peerHost(row.peer.url)}>
        <span className="block max-w-48 truncate">
          {peerHost(row.peer.url)}
        </span>
      </Tooltip>
    ) : (
      <Muted />
    ),
  header: "Peer",
  title: "Oracle service host",
}

const SERVICE_COLUMNS: Column<SignerRow>[] = [
  {
    cell: (row) => {
      const version = row.peer?.snapshot?.version
      return version ? (
        <Tooltip content={version}>
          <span className="font-mono">{version.slice(0, 7)}</span>
        </Tooltip>
      ) : (
        <Muted />
      )
    },
    header: "Version",
    title: "Oracle service version",
  },
  {
    align: "right",
    cell: (row) => {
      const latency = row.peer?.snapshot?.latency_ms
      return latency == null ? (
        <Muted />
      ) : (
        `${formatNumber(Math.round(latency))} ms`
      )
    },
    header: "Latency",
    title: "Oracle peer latency",
    sortValue: (row) => row.peer?.snapshot?.latency_ms,
  },
]

const useLivePeers = () => {
  const now = useNow()
  const peers = useQuery(oracleQueries.peers()).data?.peers ?? []
  const queried = peers.find((peer) => peer.queried)
  const observedAt = queried?.snapshot?.observed_at
  const live = Boolean(
    observedAt && now - Date.parse(observedAt) <= PEER_MAX_AGE
  )
  return { live, peers: live ? peers : [], queried }
}

function Peers({
  signers,
  threshold,
  error,
}: {
  signers?: string[]
  threshold?: string | null
  error?: Error | null
}) {
  const now = useNow()
  const { live, peers, queried } = useLivePeers()
  const added = new Map(
    useQuery(oracleQueries.events("signer_added"))
      .data?.events.flatMap((event) =>
        event.data.kind === "signer_added"
          ? [[event.data.signer.toLowerCase(), event] as const]
          : []
      )
      .reverse()
  )
  const total = signers?.length ?? 0
  const multisigHover = (row: SignerRow) => {
    const timestamp =
      row.signer && added.get(row.signer.toLowerCase())?.block_timestamp
    const days = timestamp && Math.floor((now - Date.parse(timestamp)) / DAY)
    const lines = [
      ...(threshold ? [`Threshold ${threshold} of ${total}`] : []),
      timestamp
        ? days
          ? `Added ${plural(days, "day")} ago`
          : "Added today"
        : "Multisig signer",
    ]
    return (
      <span className="flex flex-col gap-0.5">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    )
  }
  const failure = queried?.error
  const status = (row: SignerRow) =>
    failure ? (
      <Badge tone="error" title={PEER_ERRORS[failure]}>
        Failed
      </Badge>
    ) : live ? (
      <PeerStatus peer={row.peer} />
    ) : (
      <Muted />
    )
  const columns: Column<SignerRow>[] = [
    {
      cell: (row) =>
        row.signer ? (
          <span className="flex items-center gap-2">
            <AddressLink address={row.signer} />
            {row.configured ? (
              <Badge tone="success" title={multisigHover(row)}>
                Multisig
              </Badge>
            ) : null}
          </span>
        ) : (
          <Muted />
        ),
      header: "Signer",
      title: "Oracle signer address",
    },
    PEER_COLUMN,
    {
      cell: status,
      header: "Status",
      title: "Oracle service status",
    },
    ...SERVICE_COLUMNS,
  ]
  return (
    <Panel title="Peers">
      <DataTable
        columns={columns}
        rows={signers && signerRows(signers, peers)}
        rowKey={(row) => row.key}
        empty="No signers configured"
        error={error}
      />
    </Panel>
  )
}

const FAST_MINT_COLUMNS: Column<IndexedContractEvent>[] = [
  {
    cell: (event) => <RelativeTime value={event.block_timestamp} />,
    header: "Time",
    title: "Mint block time",
  },
  {
    align: "right",
    cell: ({ data }) =>
      data.kind === "fast_mint" ? (
        <TokenAmount tokenId={data.hub_token_id} amount={data.amount} />
      ) : null,
    header: "Amount",
    title: "Minted amount and token",
  },
  {
    align: "right",
    cell: ({ data }) =>
      data.kind === "fast_mint" ? (
        <FastMintValue tokenId={data.hub_token_id} amount={data.amount} />
      ) : null,
    header: "Value",
    title: "Minted amount in USD",
  },
  {
    cell: ({ data }) =>
      data.kind === "fast_mint" ? (
        <AddressLink address={data.hub_to_address} />
      ) : null,
    header: "Recipient",
    title: "Mint recipient account",
  },
  {
    cell: (event) => <TxLink hash={event.tx_hash} />,
    header: "Transaction",
    title: "Mint transaction hash",
  },
]

function FastMintValue({
  tokenId,
  amount,
}: {
  tokenId: string
  amount: string
}) {
  const token = useTokens()?.get(tokenId)
  return token ? (
    <UsdValue tokenId={tokenId} amount={amount} decimals={token.decimals} />
  ) : (
    <Muted>...</Muted>
  )
}

const ACTION_LABELS: Record<OracleAction["kind"], string> = {
  burn: "Burn",
  fast_mint: "Fast mint",
  mint: "Mint",
  transfer: "Transfer",
  unknown: "Unknown",
}

const ACTION_TONES = {
  ...TRANSFER_KIND_TONES,
  fast_mint: TRANSFER_KIND_TONES.mint,
  unknown: "neutral",
} as const

function ActionSummary({ action }: { action: OracleAction }) {
  return (
    <span className="flex flex-wrap items-center gap-x-(--flow-gap) gap-y-1 [--flow-gap:--spacing(3)]">
      <Badge tone={ACTION_TONES[action.kind]}>
        {ACTION_LABELS[action.kind]}
      </Badge>
      {action.kind === "unknown" ? (
        <HashText value={action.data} />
      ) : (
        <>
          <TokenAmount tokenId={action.token_id} amount={action.amount} />
          {"from" in action ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-fg-muted">from</span>
              <AddressLink address={action.from} />
            </span>
          ) : null}
          {"to" in action ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-fg-muted">to</span>
              <AddressLink address={action.to} />
            </span>
          ) : null}
        </>
      )}
    </span>
  )
}

const EXECUTION_COLUMNS: Column<IndexedOracleExecution>[] = [
  {
    cell: (execution) => <RelativeTime value={execution.block_timestamp} />,
    header: "Time",
    title: "Execution block time",
  },
  {
    cell: (execution) =>
      execution.actions.length ? (
        <CopyOverlay value="always">
          <span className="flex flex-col gap-1">
            {execution.actions.map((action, index) => (
              <ActionSummary key={index} action={action} />
            ))}
          </span>
        </CopyOverlay>
      ) : (
        <Muted />
      ),
    header: "Actions",
    title: "Decoded execution actions",
  },
  {
    cell: (execution) =>
      execution.succeeded ? (
        <Badge tone="success" title="Execution event succeeded">
          Executed
        </Badge>
      ) : (
        <Badge tone="error" title="Execution event failed">
          Failed
        </Badge>
      ),
    header: "Status",
    title: "Execution event outcome",
  },
  {
    cell: (execution) =>
      execution.signers?.length ? (
        <CollapsedList>
          {execution.signers.map((signer) => (
            <AddressLink key={signer} address={signer} />
          ))}
        </CollapsedList>
      ) : (
        <Muted />
      ),
    header: "Signers",
    title: "Recovered signature signers",
  },
  {
    cell: (execution) => <HashText value={execution.idempotency_key} />,
    header: "Key",
    title: "Idempotency key",
  },
  {
    cell: (execution) => <TxLink hash={execution.tx_hash} />,
    header: "Transaction",
    title: "Execution transaction hash",
  },
]

function Executions({ signers }: { signers: string[] }) {
  const [signer, setSigner] = useState("")
  const pages = useCursorPages(signer)
  const { data, error, isPlaceholderData } = useQuery(
    oracleQueries.executions(pages.cursor, signer || undefined)
  )
  const { peers } = useLivePeers()
  return (
    <Panel
      title="Executions"
      actions={
        <>
          <Picker
            noun="signer"
            options={signerRows(signers, peers)
              .filter((row) => row.configured)
              .map(({ key, peer }) => ({
                hint: key,
                id: key,
                name: shortAddress(key),
                trailing: (
                  <Tooltip content={peer?.url && peerHost(peer.url)}>
                    <span className="w-24 truncate">
                      {peer?.url ? peerHost(peer.url) : <Muted />}
                    </span>
                  </Tooltip>
                ),
              }))}
            value={signer}
            label="Select signer"
            onChange={setSigner}
            onClear={() => setSigner("")}
            variant="field"
            align="end"
            className="w-40"
          />
          <CursorPager pages={pages} next={data?.pagination.next_cursor} />
        </>
      }
    >
      <DataTable
        columns={EXECUTION_COLUMNS}
        rows={data?.executions}
        rowKey={(execution) => `${execution.tx_hash}:${execution.log_index}`}
        empty={
          signer
            ? data?.pagination.next_cursor
              ? "No executions in scanned range"
              : "No executions found"
            : "No executions"
        }
        pending={isPlaceholderData}
        error={error}
      />
    </Panel>
  )
}

type LimitFilter = "all" | "enabled" | "disabled"

const LIMIT_FILTERS: Array<{ label: string; value: LimitFilter }> = [
  { label: "All", value: "all" },
  { label: "Enabled", value: "enabled" },
  { label: "Disabled", value: "disabled" },
]

const usd = (value: string, decimals: number) => Number(value) / 10 ** decimals

const RATE_LIMIT_COLUMNS: Column<RateLimitConfiguration>[] = [
  {
    cell: (limit) => <ChainLink chain={limit.chain} />,
    header: "Chain",
    title: "Rate limit chain",
    sortValue: (limit) => limit.chain,
  },
  {
    cell: (limit) =>
      limit.enabled ? (
        <Badge tone="success" title="Rate limit is enforced">
          Enabled
        </Badge>
      ) : (
        <Badge tone="muted" title="Rate limit is not enforced">
          Disabled
        </Badge>
      ),
    header: "Status",
    title: "Rate limit enforcement status",
    sortValue: (limit) => (limit.enabled ? 0 : 1),
  },
  {
    align: "right",
    cell: (limit) => (
      <Tooltip content={limit.capacity}>
        <span>
          <UsdAmount value={usd(limit.capacity, limit.decimals)} />
        </span>
      </Tooltip>
    ),
    header: "Capacity",
    title: "Maximum USD budget",
    sortValue: (limit) => usd(limit.capacity, limit.decimals),
  },
  {
    align: "right",
    cell: (limit) => (
      <Tooltip content={limit.refill_per_second}>
        <span>
          <UsdAmount value={usd(limit.refill_per_second, limit.decimals)} />
          /s
        </span>
      </Tooltip>
    ),
    header: "Refill",
    title: "USD budget refilled per second",
    sortValue: (limit) => usd(limit.refill_per_second, limit.decimals),
  },
  {
    align: "right",
    cell: (limit) => (
      <Tooltip content={limit.remaining}>
        <span>
          <UsdAmount value={usd(limit.remaining, limit.decimals)} />
        </span>
      </Tooltip>
    ),
    header: "Remaining",
    title: "Remaining USD budget",
    sortValue: (limit) => usd(limit.remaining, limit.decimals),
  },
]

function RateLimits({
  limits,
  error,
}: {
  limits?: RateLimitConfiguration[]
  error?: Error | null
}) {
  const [filter, setFilter] = useState<LimitFilter>("all")
  const matches = limits?.filter(
    (limit) => filter === "all" || limit.enabled === (filter === "enabled")
  )
  const pages = useListPages(matches?.length, filter)
  return (
    <Panel
      title="Rate Limits"
      badge={
        limits && matches ? (
          <TitleCount
            label="rate limits"
            shown={matches.length}
            total={limits.length}
            filtered={filter !== "all"}
          />
        ) : null
      }
      actions={
        <>
          <SegmentedControl
            label="Rate limit status"
            options={LIMIT_FILTERS}
            value={filter}
            onChange={setFilter}
          />
          <ListPager pages={pages} />
        </>
      }
    >
      <DataTable
        columns={RATE_LIMIT_COLUMNS}
        rows={matches}
        page={pages}
        defaultSort={{ column: 1, descending: false }}
        rowKey={(limit) => limit.chain}
        empty="No rate limits"
        error={error}
      />
    </Panel>
  )
}

export default function OraclePage() {
  const { data: response, error } = useQuery(oracleQueries.state())
  const state = response?.state
  const configuration = state?.snapshot?.configuration
  const multisig = dependency(response, "oracle_multisig")
  const multisigConfiguration = multisig?.state?.snapshot?.configuration
  const rateLimiter = dependency(response, "rate_limiter")
  const rateLimits = rateLimiter?.state?.snapshot?.configuration.rate_limits
  const oracleDependency = (kind: OracleDependency["kind"]) =>
    configuration?.dependencies.find((entry) => entry.kind === kind)?.address

  return (
    <>
      <Peers
        signers={response && (multisigConfiguration?.signers ?? [])}
        threshold={multisigConfiguration?.threshold}
        error={error}
      />
      <Executions signers={multisigConfiguration?.signers ?? []} />
      <EventPanel
        title="Fast Mints"
        events={oracleQueries.events}
        kind="fast_mint"
        columns={FAST_MINT_COLUMNS}
        empty="No fast mints"
      />
      <RateLimits limits={response && (rateLimits ?? [])} error={error} />
      <RolesPanel
        roles={response && (configuration?.roles ?? [])}
        error={error}
      />
      <EventPanel
        title="Admin Events"
        events={oracleQueries.events}
        kinds={ORACLE_EVENT_KINDS}
        columns={eventColumns({ usdDecimals: rateLimits?.[0]?.decimals })}
      />
      <ConfigurationPanel
        response={response}
        error={error}
        items={[
          addressItem("contract", response?.contract_address),
          addressItem("hub", configuration?.hub),
          addressItem("idempotency_store", configuration?.idempotency_store),
          addressItem("oracle_multisig", multisig?.address),
          addressItem("multisig_owner", multisigConfiguration?.owner),
          addressItem(
            "multisig_pending_owner",
            multisigConfiguration?.pending_owner
          ),
          addressItem("rate_limiter", oracleDependency("rate_limiter")),
          addressItem("fee_calculator", oracleDependency("fee_calculator")),
        ]}
      />
    </>
  )
}
