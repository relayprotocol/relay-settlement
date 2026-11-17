import { useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ContractEventsQuery } from "../api/queries"
import type { IndexedContractEvent } from "../api/schema"
import { providerName } from "../labels"
import { roleName } from "../roles"
import { useTokens } from "../tokens"
import {
  capitalize,
  formatAmount,
  formatBytes,
  formatDeviation,
  formatDuration,
  formatNumber,
  formatPercent,
  formatUsdPrice,
} from "../utils"
import { CursorPager, useCursorPages } from "./pagination"
import { UsdAmount } from "./Usd"
import {
  AccountLink,
  AddressLink,
  ChainLink,
  CopyOverlay,
  HashText,
  HubTokenLink,
  TxLink,
} from "./links"
import { Picker } from "./Picker"
import { Tooltip } from "./Tooltip"
import {
  Badge,
  CollapsedList,
  DataTable,
  isMaxLimit,
  MaxLimit,
  Muted,
  Panel,
  RelativeTime,
  type Column,
} from "./ui"

const ADDRESS = /^0x[0-9a-f]{40}$/i
const HASH = /^0x[0-9a-f]{64}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/
const DECIMAL = /^-?\d+\.\d+$/
const SIGNIFICANT = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
})
const TOKEN_FIELDS = new Set([
  "hub_token_id",
  "token_id",
  "token_in",
  "token_out",
])

const BUSY_KINDS = new Set([
  "executor_executed",
  "fast_mint",
  "gas_paid",
  "payload_built",
  "tokens_consumed",
])

const USD_FIELDS = new Set([
  "capacity",
  "refill_per_second",
  "remaining",
  "usd_amount",
])

const AMOUNT_TOKENS: Record<string, string> = {
  amount: "hub_token_id",
  amount_in: "token_in",
  amount_out: "token_out",
}

const DECIMALS_FIELDS = new Set([
  "balance",
  "burn_limit",
  "burning_limit",
  "capacity",
  "deficit",
  "mint_limit",
  "minting_limit",
  "reserve",
  "reserves",
  "supply",
])

const LIMIT_FIELDS = new Set([
  "burn_limit",
  "burning_limit",
  "mint_limit",
  "minting_limit",
])

const ENUM_FIELDS = new Set(["dependency", "error", "status"])

const SHORT_LABELS: Record<string, string> = {
  "hub to address": "recipient",
  "hub token id": "token",
  "withdraw request hash": "request",
}

const KEY_LABEL_FIELDS = new Set(["depository_hash"])

const REDUNDANT_FIELDS: Record<string, string> = { symbol: "token_id" }

const SOLIDITY_NAMES: Record<string, string> = {
  chain_id_hash: "chainId",
  depository_hash: "depository",
  erc20_view_created: "ERC20ViewCreated",
  executor_executed: "Executed",
  refill_per_second: "rate",
  xerc20_bridge_limits_set: "BridgeLimitsSet",
  xerc20_lockbox_deposit: "Deposit",
  xerc20_lockbox_set: "LockboxSet",
  xerc20_lockbox_withdraw: "Withdraw",
}

const SOLIDITY_EVENT_PARAMS: Partial<Record<string, Record<string, string>>> = {
  approval: { token_id: "id" },
  bucket_config_set: { enabled: "isEnabled" },
}

const SOLADY_OWNABLE_KINDS = new Set(["depository", "gateway_depository"])

const DERIVED_FIELDS = new Set([
  "chain",
  "hash_count",
  "payload_bytes",
  "payload_hash",
])

const rawValue = (field: unknown) =>
  typeof field === "string" ? field : JSON.stringify(field)

const camelCase = (key: string) =>
  key.replace(/_([a-z\d])/g, (_, char: string) => char.toUpperCase())

const words = (name: string) =>
  name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase()

const ACRONYMS: Record<string, string> = { erc20: "ERC20", usdc: "USDC" }

export const eventKindLabel = (kind: string) =>
  capitalize(
    words(kind)
      .split(" ")
      .map((word) => ACRONYMS[word] ?? word)
      .join(" ")
  )

const solidityEventName = (kind: string) =>
  kind === "undecoded"
    ? kind
    : (SOLIDITY_NAMES[kind] ?? capitalize(camelCase(kind)))

const contractEventLabel = (kind: string) =>
  eventKindLabel(solidityEventName(kind))

const solidityParamName =
  ({ contract_kind, data }: IndexedContractEvent) =>
  (key: string) =>
    data.kind === "undecoded" || DERIVED_FIELDS.has(key)
      ? key
      : SOLADY_OWNABLE_KINDS.has(contract_kind) && key === "previous_owner"
        ? "oldOwner"
        : (SOLIDITY_EVENT_PARAMS[data.kind]?.[key] ??
          SOLIDITY_NAMES[key] ??
          camelCase(key))

const fieldLabel = (name: string) =>
  SHORT_LABELS[words(name)] ?? words(name).replace(/ (seconds|bytes)$/, "")

export function TokenAmount({
  tokenId,
  amount,
}: {
  tokenId: string
  amount: string
}) {
  const tokens = useTokens()
  if (!tokens) return <Muted>...</Muted>
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={amount}>
        <span className="tabular-nums">
          {formatAmount(amount, tokens.get(tokenId)?.decimals)}
        </span>
      </Tooltip>
      <HubTokenLink tokenId={tokenId} />
    </span>
  )
}

export function MissingBindings({ missing }: { missing: string[] }) {
  return missing.length ? (
    <CollapsedList>
      {missing.map((signature) => {
        const prefix = signature.match(/^(?:function|event) /)?.[0]
        return (
          <span key={signature} className="max-w-full font-mono wrap-anywhere">
            {prefix && <span className="opacity-60">{prefix}</span>}
            {signature.slice(prefix?.length ?? 0)}
          </span>
        )
      })}
    </CollapsedList>
  ) : (
    <Muted />
  )
}

export function FieldList({
  data,
  hidden = [],
  chain,
  usdDecimals,
  decimals,
  codeName = (key) => key,
}: {
  data: Record<string, unknown>
  hidden?: string[]
  chain?: string
  usdDecimals?: number
  decimals?: number
  codeName?: (key: string) => string
}) {
  const tokens = useTokens()
  const amountDecimals =
    typeof data.decimals === "number" ? data.decimals : decimals
  const value = (key: string, field: unknown): ReactNode => {
    if (usdDecimals != null && USD_FIELDS.has(key) && typeof field === "string")
      return <UsdAmount value={Number(field) / 10 ** usdDecimals} />
    if (TOKEN_FIELDS.has(key) && typeof field === "string")
      return <HubTokenLink tokenId={field} />
    const amountToken = data[AMOUNT_TOKENS[key] ?? ""]
    if (typeof amountToken === "string" && typeof field === "string")
      return tokens ? (
        formatAmount(field, tokens.get(amountToken)?.decimals)
      ) : (
        <Muted>...</Muted>
      )
    if (
      LIMIT_FIELDS.has(key) &&
      typeof field === "string" &&
      /^\d+$/.test(field) &&
      isMaxLimit(field)
    )
      return <MaxLimit value={field} />
    if (
      DECIMALS_FIELDS.has(key) &&
      typeof field === "string" &&
      amountDecimals != null
    )
      return formatAmount(field, amountDecimals)
    if (key === "provider_id" && typeof field === "string")
      return providerName(field)
    if (key === "role" && typeof field === "string") return roleName(field)
    if (key === "chain" && typeof field === "string")
      return (
        <ChainLink
          chain={field}
          depository={
            typeof data.depository === "string" ? data.depository : undefined
          }
        />
      )
    if (ENUM_FIELDS.has(key) && typeof field === "string")
      return capitalize(field.replaceAll("_", " "))
    if (typeof field === "boolean") return field ? "True" : "False"
    if (typeof field === "number") {
      if (key === "threshold_bps" || key === "share_bps")
        return formatPercent(field / 10_000)
      if (key.endsWith("_bps")) return formatDeviation(field / 10_000)
      if (key.endsWith("_seconds")) return formatDuration(field * 1000)
      if (key.endsWith("_bytes")) return formatBytes(field)
      return formatNumber(field)
    }
    if (typeof field === "string" && ADDRESS.test(field))
      return chain ? (
        <AccountLink address={field} chain={chain} />
      ) : (
        <AddressLink address={field} />
      )
    if (typeof field === "string" && HASH.test(field))
      return <HashText value={field} />
    if (typeof field === "string" && TIMESTAMP.test(field))
      return <RelativeTime value={field} />
    if (key.endsWith("usd_price") && typeof field === "string")
      return formatUsdPrice(field)
    if (typeof field === "string" && DECIMAL.test(field))
      return SIGNIFICANT.format(Number(field))
    if (Array.isArray(field)) {
      if (key === "missing" && field.every((item) => typeof item === "string"))
        return <MissingBindings missing={field} />
      return (
        <CollapsedList>
          {field.map((item, index) => (
            <span key={index} className="max-w-full wrap-anywhere">
              {value(key, item)}
            </span>
          ))}
        </CollapsedList>
      )
    }
    return String(field)
  }
  const fields = Object.entries(data).filter(
    ([key, field]) =>
      key !== "kind" &&
      !hidden.includes(key) &&
      field != null &&
      data[REDUNDANT_FIELDS[key] ?? ""] == null
  )
  if (!fields.length) return <Muted />
  return (
    <CopyOverlay value="always">
      <dl className="flex min-w-80 flex-wrap gap-x-(--copy-gap) gap-y-1">
        {fields.map(([key, field]) => {
          const shown = value(key, field)
          const raw = rawValue(field)
          return (
            <div key={key} className="flex max-w-full items-baseline gap-1.5">
              <Tooltip content={codeName(key)}>
                <dt className="shrink-0 text-xs text-fg-muted">
                  {fieldLabel(KEY_LABEL_FIELDS.has(key) ? key : codeName(key))}
                </dt>
              </Tooltip>
              <Tooltip
                content={
                  typeof shown === "string" && shown !== raw ? raw : undefined
                }
              >
                <dd className="min-w-0 wrap-anywhere whitespace-normal">
                  {shown}
                </dd>
              </Tooltip>
            </div>
          )
        })}
      </dl>
    </CopyOverlay>
  )
}

export const eventKindColumn: Column<IndexedContractEvent> = {
  cell: (event) => (
    <Badge title={solidityEventName(event.data.kind)}>
      {contractEventLabel(event.data.kind)}
    </Badge>
  ),
  header: "Event",
  title: "Contract event type",
}

export const eventColumns = ({
  hidden,
  chain,
  usdDecimals,
  decimals,
}: {
  hidden?: string[]
  chain?: string
  usdDecimals?: number
  decimals?: (event: IndexedContractEvent) => number | undefined
} = {}): Column<IndexedContractEvent>[] => [
  {
    cell: (event) => <RelativeTime value={event.block_timestamp} />,
    header: "Time",
    title: "Event block time",
  },
  eventKindColumn,
  {
    cell: (event) => (
      <FieldList
        data={event.data}
        hidden={hidden}
        chain={chain}
        usdDecimals={usdDecimals}
        decimals={decimals?.(event)}
        codeName={solidityParamName(event)}
      />
    ),
    header: "Details",
    title: "Event fields",
    fill: true,
  },
  {
    cell: (event) => <TxLink hash={event.tx_hash} chain={chain} />,
    header: "Transaction",
    title: "Event transaction hash",
  },
]

const EVENT_COLUMNS = eventColumns()

export const eventRowKey = (event: IndexedContractEvent) =>
  `${event.tx_hash}:${event.log_index}`

export function EventPanel({
  title,
  events,
  kind: fixedKind,
  kinds,
  columns = EVENT_COLUMNS,
  empty = "No events",
}: {
  title: string
  events: (kind?: string, cursor?: string) => ContractEventsQuery
  kind?: string
  kinds?: string[]
  columns?: Column<IndexedContractEvent>[]
  empty?: string
}) {
  const [selected, setSelected] = useState("")
  const kind =
    fixedKind ??
    (selected ||
      kinds?.filter((option) => !BUSY_KINDS.has(option)).join(",") ||
      undefined)
  const pages = useCursorPages(kind)
  const { data, error, isPlaceholderData } = useQuery(
    events(kind, pages.cursor)
  )

  return (
    <Panel
      title={title}
      actions={
        <>
          {kinds ? (
            <Picker
              noun="event"
              options={kinds.map((kind) => ({
                id: kind,
                name: contractEventLabel(kind),
              }))}
              value={selected}
              label="Select event"
              onChange={setSelected}
              onClear={() => setSelected("")}
              variant="field"
              align="end"
              className="w-44"
            />
          ) : null}
          <CursorPager pages={pages} next={data?.pagination.next_cursor} />
        </>
      }
    >
      <DataTable
        columns={columns}
        rows={data?.events}
        rowKey={eventRowKey}
        empty={empty}
        pending={isPlaceholderData}
        error={error}
      />
    </Panel>
  )
}
