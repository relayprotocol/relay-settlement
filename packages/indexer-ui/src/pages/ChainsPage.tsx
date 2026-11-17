import { Fragment, useState } from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { useQueries, useQuery } from "@tanstack/react-query"
import { chainQueries, priceQueries, type OriginFilter } from "../api/queries"
import type {
  Deposit,
  DepositoryState,
  DepositoryTokenState,
  FacadeConfigView,
  VmType,
  Withdrawal,
  WithdrawalKind,
} from "../api/schema"
import { ChainIcon } from "../components/ChainIcon"
import { Picker, chainOptions } from "../components/Picker"
import { ConfigurationPanel } from "../components/contract"
import { ChainCharts } from "../components/ChainCharts"
import { eventColumns, EventPanel } from "../components/events"
import {
  AccountLink,
  ContractAddress,
  HubTokenLink,
  TxLink,
} from "../components/links"
import {
  CursorPager,
  ListPager,
  useCursorPages,
  useListPages,
} from "../components/pagination"
import {
  chainState,
  ChainStatusBadge,
  SNAPSHOT_ERROR_HINTS,
} from "../components/status"
import { UsdAmount, UsdValue } from "../components/Usd"
import {
  Amount,
  Badge,
  DataTable,
  EmptyState,
  LoadState,
  Muted,
  Panel,
  RelativeTime,
  SearchInput,
  SegmentedControl,
  TitleCount,
  type Column,
} from "../components/ui"
import { Tooltip } from "../components/Tooltip"
import {
  assetId,
  assetValues,
  balanceOf,
  decimalsOf,
  usdPrice,
} from "../depositoryValues"
import { useLabels } from "../labels"
import {
  assetStates,
  isNativeAsset,
  chainPath,
  representativeStates,
  useOriginChains,
  vmLabel,
  type OriginChain,
} from "../origins"
import { useSearch } from "../search"
import { readStorage, writeStorage } from "../storage"
import { useTokens } from "../tokens"
import {
  cx,
  displayTokenLabel,
  formatAmount,
  formatNumber,
  formatPercent,
  shortAddress,
} from "../utils"

const STORED_CHAIN = "chains:chain"
const DEFAULT_CHAIN = "ethereum"
const EVM_HASH = /^0x[0-9a-f]{64}$/i
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/
const BITCOIN_TXID = /^(0x)?[0-9a-f]{64}$/i
const BITCOIN_ADDRESS =
  /^(bc1[02-9ac-hj-np-z]{11,87}|BC1[02-9AC-HJ-NP-Z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/

const WITHDRAWAL_KINDS: Record<WithdrawalKind, string> = {
  call: "Call",
  native_transfer: "Native",
  token_transfer: "Token",
}

const DEPOSITORY_KINDS: Array<{
  label: string
  value: "default" | "gateway"
}> = [
  { label: "Default", value: "default" },
  { label: "Gateway", value: "gateway" },
]

const WITHDRAWAL_FILTERS: Array<{
  label: string
  value: WithdrawalKind | "all"
}> = [
  { label: "All", value: "all" },
  { label: "Native", value: "native_transfer" },
  { label: "Token", value: "token_transfer" },
  { label: "Call", value: "call" },
]

const searchFilter = (value: string, vm: VmType): OriginFilter | undefined => {
  if (!value) return {}
  if (vm === "solana-vm") {
    if (!BASE58.test(value)) return undefined
    if (value.length >= 64 && value.length <= 88) return { txHash: value }
    if (value.length >= 32 && value.length <= 44) return { account: value }
    return undefined
  }
  if (vm === "bitcoin-vm") {
    if (BITCOIN_TXID.test(value))
      return { txHash: value.replace(/^0x/, "").toLowerCase() }
    if (BITCOIN_ADDRESS.test(value)) return { account: value }
    return undefined
  }
  if (EVM_HASH.test(value)) return { txHash: value.toLowerCase() }
  if (EVM_ADDRESS.test(value)) return { account: value.toLowerCase() }
  return undefined
}

function OriginAmount({
  amount,
  token,
  state,
  chain,
}: {
  amount?: string | null
  token?: string | null
  state?: DepositoryState
  chain: string
}) {
  if (amount == null) return <Muted />
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={amount}>
        <span className="tabular-nums">
          {formatAmount(amount, state && decimalsOf(state))}
        </span>
      </Tooltip>
      {state ? (
        <HubTokenLink tokenId={state.token_id} />
      ) : (
        <AccountLink address={token} chain={chain} />
      )}
    </span>
  )
}

function OriginValue({
  amount,
  state,
}: {
  amount?: string | null
  state?: DepositoryState
}) {
  if (amount == null || !state) return <Muted />
  return (
    <UsdValue
      tokenId={state.token_id}
      amount={amount}
      decimals={decimalsOf(state)}
    />
  )
}

const useAssetValues = (
  states?: DepositoryState[],
  facades?: FacadeConfigView[]
) => {
  const prices = useQueries({
    queries: (states ?? []).map((state) => priceQueries.price(state.token_id)),
  })
  if (
    !states ||
    prices.some((price) => price.data === undefined && !price.error)
  )
    return undefined
  const byToken = new Map(
    states.map((state, index) => [
      state.token_id,
      usdPrice(prices[index]?.data),
    ])
  )
  const { assets, total } = assetValues(
    states,
    (tokenId) => byToken.get(tokenId),
    facades
  )
  return {
    share: (state: DepositoryState) => {
      const asset = assets.get(assetId(state, facades))
      return asset?.state !== state || asset.value == null || !total
        ? null
        : asset.value / total
    },
    total,
  }
}

const balanceRatio = (balances: Array<number | null>) => {
  const values = balances.filter((value): value is number => value != null)
  const peak = Math.max(0, ...values)
  const latest = values.at(-1)
  if (latest == null) return null
  return peak ? latest / peak : 0
}

function DepositorySummary({
  origin,
  address,
  states,
  error,
}: {
  origin?: OriginChain
  address: string
  states?: DepositoryState[]
  error?: Error | null
}) {
  const total = useAssetValues(states, origin?.facades)?.total
  const { data: stats } = useQuery({
    ...chainQueries.activityStats(origin?.chain ?? "", address),
    enabled: !!origin && !origin.deprecated,
  })
  const ratio =
    stats && !origin?.deprecated
      ? balanceRatio(stats.buckets.map((bucket) => bucket.balance_usd ?? null))
      : null

  return (
    <div className="flex w-full flex-col gap-3 sm:w-md sm:items-end">
      <span className="text-2xl font-semibold text-success-fg tabular-nums">
        {origin?.deprecated ? (
          <Muted>-</Muted>
        ) : total == null ? (
          <Muted>{error || total === null ? "-" : "..."}</Muted>
        ) : (
          <UsdAmount value={total} />
        )}
      </span>
      {ratio != null && (
        <Tooltip content="Balance relative to 24h maximum">
          <div
            role="meter"
            aria-label="Balance relative to 24h maximum"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            className="h-3 w-full overflow-hidden rounded-sm bg-element"
          >
            <div
              className={cx(
                "h-full rounded-sm bg-chart/80 transition-[width] duration-500",
                ratio > 0 && "min-w-1"
              )}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        </Tooltip>
      )}
    </div>
  )
}

function DepositoryPicker({
  chains,
  chain,
  origin,
  address,
  gateway,
}: {
  chains?: OriginChain[]
  chain: string
  origin?: OriginChain
  address: string
  gateway: boolean
}) {
  const navigate = useNavigate()
  const labels = useLabels()
  const { data: states, error } = useQuery({
    ...chainQueries.balances(chain, address),
    enabled: !!origin,
  })
  const status = origin?.status
  const options = chainOptions(chains ?? [])

  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 p-4">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2">
          <ChainIcon
            id={origin?.network_id}
            name={origin?.label ?? ""}
            className="size-12 sm:row-span-2"
            eager
          />
          <div className="flex flex-wrap items-center gap-2 sm:self-end">
            <Picker
              noun="chain"
              options={options}
              value={chain}
              label={chain ? labels.chain(chain) : "Select chain"}
              onChange={(next) => {
                writeStorage(STORED_CHAIN, next)
                navigate(chainPath(next))
              }}
            />
            {origin ? (
              <Badge title="VM type">{vmLabel(origin.vm_type)}</Badge>
            ) : null}
            {origin?.network_id ? (
              <Badge title="Chain ID">{origin.network_id}</Badge>
            ) : null}
            {origin?.deprecated ? (
              <Badge tone="warning" title="No longer supported by Relay">
                Deprecated
              </Badge>
            ) : null}
            {status && chainState(status) !== "synced" ? (
              <ChainStatusBadge status={status} />
            ) : null}
          </div>
          {origin?.gateway_depository ? (
            <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:col-start-2">
              <ContractAddress
                chain={origin.chain}
                address={address}
                label="Depository"
              />
              <SegmentedControl
                label="Depository kind"
                options={DEPOSITORY_KINDS}
                value={gateway ? "gateway" : "default"}
                onChange={(kind) =>
                  navigate(chainPath(chain, kind === "gateway"))
                }
              />
            </div>
          ) : origin ? (
            <ContractAddress
              chain={origin.chain}
              address={address}
              label="Depository"
            />
          ) : chains ? null : (
            <span
              aria-hidden
              className="col-span-2 h-8 w-80 max-w-full justify-self-start rounded-md bg-element motion-safe:animate-pulse sm:col-span-1 sm:col-start-2"
            />
          )}
        </div>
        {origin || !chains ? (
          <DepositorySummary
            origin={origin}
            address={address}
            states={states}
            error={error}
          />
        ) : null}
      </div>
    </section>
  )
}

type TokenRow = {
  state: DepositoryTokenState
  facade?: FacadeConfigView
  label: string
  name: string
  share?: number | null
}

const tokenAmount = (row: TokenRow, value?: string | null, hint?: string) =>
  value == null ? (
    <Muted />
  ) : (
    <Amount value={value} decimals={decimalsOf(row.state)} hint={hint} />
  )

const TOKEN_COLUMNS: Column<TokenRow>[] = [
  {
    cell: (row) => (
      <span className="inline-flex max-w-full items-center gap-2">
        <HubTokenLink tokenId={row.state.token_id} />
        {row.facade ? (
          <Badge
            title={
              isNativeAsset(row.facade.target)
                ? "ERC20 view of native balance"
                : "ERC20 view of another token"
            }
          >
            Facade
          </Badge>
        ) : null}
      </span>
    ),
    header: "Token",
    title: "Token name or symbol",
    sortValue: (row) => row.label,
  },
  {
    align: "right",
    cell: (row) => {
      const snapshot = row.state.snapshot
      const error = row.state.error
      if (error && balanceOf(row.state) == null)
        return (
          <Badge tone="error" title={SNAPSHOT_ERROR_HINTS[error]}>
            Failed
          </Badge>
        )
      return tokenAmount(
        row,
        balanceOf(row.state),
        snapshot ? `Block ${formatNumber(snapshot.block_number)}` : undefined
      )
    },
    header: "Balance",
    title: "Depository balance",
  },
  {
    align: "right",
    cell: (row) => tokenAmount(row, row.state.total_supply),
    header: "Supply",
    title: "Hub total supply",
  },
  {
    align: "right",
    cell: (row) => (
      <OriginValue amount={balanceOf(row.state)} state={row.state} />
    ),
    header: "Value",
    title: "Balance in USD",
  },
  {
    align: "right",
    cell: (row) =>
      row.share == null ? (
        <Muted>{row.share === undefined ? "..." : "-"}</Muted>
      ) : (
        formatPercent(row.share)
      ),
    header: "Share",
    title: "Share of depository value",
    sortValue: (row) => row.share,
  },
  {
    align: "right",
    cell: (row) => (
      <span className={row.state.error ? "text-error-fg" : undefined}>
        <RelativeTime
          value={row.state.last_attempt_at}
          hint={
            row.state.error ? SNAPSHOT_ERROR_HINTS[row.state.error] : undefined
          }
        />
      </span>
    ),
    header: "Checked",
    title: "Last balance read attempt",
    sortValue: (row) => row.state.last_attempt_at,
  },
]

function Tokens({ origin, address }: { origin: OriginChain; address: string }) {
  const { data: states, error } = useQuery(
    chainQueries.balances(origin.chain, address)
  )
  const tokens = useTokens()
  const values = useAssetValues(states, origin.facades)
  const search = useSearch()
  const query = search.query.toLowerCase()
  const rows = states?.map((state) => {
    const token = tokens?.get(state.token_id)
    return {
      facade: origin.facades.find(
        (facade) => facade.address === state.target.origin_asset?.toLowerCase()
      ),
      label: displayTokenLabel(token?.name, token?.symbol),
      name: token?.name ?? "",
      share: values?.share(state),
      state,
    }
  })
  const matches = rows?.filter(
    (row) =>
      !query ||
      row.label.toLowerCase().includes(query) ||
      row.name.toLowerCase().includes(query) ||
      row.state.target.origin_asset?.toLowerCase().includes(query)
  )
  const pages = useListPages(matches?.length, query)

  return (
    <Panel
      title="Tokens"
      badge={
        rows && matches ? (
          <TitleCount
            label="tokens"
            shown={matches.length}
            total={rows.length}
            filtered={!!query}
          />
        ) : null
      }
      actions={
        <>
          <SearchInput placeholder="Search tokens" {...search.input} />
          <ListPager pages={pages} />
        </>
      }
    >
      <DataTable
        columns={TOKEN_COLUMNS}
        rows={matches}
        page={pages}
        defaultSort={{ column: 0, descending: false }}
        rowKey={(row) => row.state.token_id}
        empty="No tokens"
        error={error}
      />
    </Panel>
  )
}

const useOriginFilter = (
  origin: OriginChain,
  address: string,
  placeholder: string,
  extraKey = ""
) => {
  const search = useSearch()
  const [token, setToken] = useState("")
  const [depository, setDepository] = useState(address)
  const parsed = searchFilter(search.query, origin.vm_type)
  const filter = { ...parsed, token: token || undefined }
  const pages = useCursorPages(
    [depository, filter.account, filter.token, filter.txHash, extraKey].join(
      ":"
    )
  )
  const states = useQuery(
    chainQueries.balances(origin.chain, origin.depository)
  ).data
  const tokens = useTokens()
  const lookup = assetStates(states ?? [], origin.vm_type)
  const tokenOptions = [
    ...representativeStates(states ?? [], origin.vm_type).values(),
  ]
    .flatMap((state) => {
      const asset = state.target.origin_asset
      if (!asset) return []
      const hubToken = tokens?.get(state.token_id)
      return [
        {
          hint: asset,
          icon: (
            <ChainIcon
              id={origin.network_id}
              name={origin.name}
              className="size-[1.25em]"
            />
          ),
          id: isNativeAsset(asset) ? "native" : asset,
          name: displayTokenLabel(hubToken?.name, hubToken?.symbol),
        },
      ]
    })
    .toSorted((a, b) => a.name.localeCompare(b.name))

  return {
    depository,
    filter,
    lookup,
    pages,
    controls: (next?: string | null) => (
      <>
        {address === origin.depository && origin.depositories.length > 1 ? (
          <Picker
            noun="depository"
            options={origin.depositories.map((address) => ({
              hint: address,
              id: address,
              name: shortAddress(address),
            }))}
            value={depository}
            label="Select depository"
            onChange={(next) => setDepository(next || origin.depository)}
            variant="field"
            align="end"
            className="w-36"
          />
        ) : null}
        <Picker
          noun="token"
          options={tokenOptions}
          value={token}
          label="Select token"
          onChange={setToken}
          onClear={() => setToken("")}
          variant="field"
          align="end"
          className="w-44"
        />
        <SearchInput
          invalid={search.query !== "" && !parsed}
          placeholder={placeholder}
          {...search.input}
        />
        <CursorPager pages={pages} next={next} />
      </>
    ),
  }
}

type AssetLookup = ReturnType<typeof assetStates>

const depositColumns = (
  chain: string,
  lookup: AssetLookup
): Column<Deposit>[] => [
  {
    cell: (deposit) => <RelativeTime value={deposit.block_timestamp} />,
    header: "Time",
    title: "Deposit block time",
  },
  {
    align: "right",
    cell: (deposit) => (
      <OriginAmount
        amount={deposit.amount}
        token={deposit.token}
        state={lookup(deposit.token)}
        chain={chain}
      />
    ),
    header: "Amount",
    title: "Deposited amount and token",
  },
  {
    align: "right",
    cell: (deposit) => (
      <OriginValue amount={deposit.amount} state={lookup(deposit.token)} />
    ),
    header: "Value",
    title: "Amount in USD",
  },
  {
    cell: (deposit) => <AccountLink address={deposit.sender} chain={chain} />,
    header: "Sender",
    title: "Deposit sender account",
  },
  {
    cell: (deposit) => <TxLink hash={deposit.tx_hash} chain={chain} />,
    header: "Transaction",
    title: "Deposit transaction hash",
  },
]

function Deposits({
  origin,
  address,
}: {
  origin: OriginChain
  address: string
}) {
  const { controls, depository, filter, lookup, pages } = useOriginFilter(
    origin,
    address,
    "Search deposits"
  )
  const {
    data: deposits,
    error,
    isPlaceholderData,
  } = useQuery(
    chainQueries.deposits(origin.chain, depository, filter, pages.cursor)
  )

  return (
    <Panel
      title="Deposits"
      actions={controls(deposits?.pagination.next_cursor)}
    >
      <DataTable
        columns={depositColumns(origin.chain, lookup)}
        rows={deposits?.deposits}
        rowKey={(deposit) => `${deposit.tx_hash}:${deposit.log_index}`}
        empty="No deposits"
        pending={isPlaceholderData}
        error={error}
      />
    </Panel>
  )
}

const withdrawalDetails = (withdrawal: Withdrawal) => {
  switch (withdrawal.vm_type) {
    case "ethereum-vm":
      return withdrawal.kind === "call"
        ? `Target ${withdrawal.target} value ${withdrawal.value}`
        : undefined
    case "solana-vm":
      return `Nonce ${withdrawal.nonce} executor ${withdrawal.executor}`
    case "bitcoin-vm":
      return `Fee ${withdrawal.fee} sat change ${withdrawal.change} sat inputs ${withdrawal.inputs.length}`
  }
}

const withdrawalColumns = (
  chain: string,
  lookup: AssetLookup
): Column<Withdrawal>[] => [
  {
    cell: (withdrawal) => <RelativeTime value={withdrawal.block_timestamp} />,
    header: "Time",
    title: "Withdrawal block time",
  },
  {
    cell: (withdrawal) => (
      <Badge title={withdrawalDetails(withdrawal)}>
        {WITHDRAWAL_KINDS[withdrawal.kind]}
      </Badge>
    ),
    header: "Kind",
    title: "Withdrawal type",
  },
  {
    align: "right",
    cell: (withdrawal) => (
      <OriginAmount
        amount={withdrawal.amount}
        token={withdrawal.token}
        state={lookup(withdrawal.token)}
        chain={chain}
      />
    ),
    header: "Amount",
    title: "Withdrawn amount and token",
  },
  {
    align: "right",
    cell: (withdrawal) => (
      <OriginValue
        amount={withdrawal.amount}
        state={lookup(withdrawal.token)}
      />
    ),
    header: "Value",
    title: "Amount in USD",
  },
  {
    cell: (withdrawal) => (
      <AccountLink address={withdrawal.recipient} chain={chain} />
    ),
    header: "Recipient",
    title: "Withdrawal recipient account",
  },
  {
    cell: (withdrawal) => <TxLink hash={withdrawal.tx_hash} chain={chain} />,
    header: "Transaction",
    title: "Withdrawal transaction hash",
  },
]

function Withdrawals({
  origin,
  address,
}: {
  origin: OriginChain
  address: string
}) {
  const [kind, setKind] = useState<WithdrawalKind | "all">("all")
  const { controls, depository, filter, lookup, pages } = useOriginFilter(
    origin,
    address,
    "Search withdrawals",
    kind
  )
  const {
    data: withdrawals,
    error,
    isPlaceholderData,
  } = useQuery(
    chainQueries.withdrawals(
      origin.chain,
      depository,
      { ...filter, kind: kind === "all" ? undefined : kind },
      pages.cursor
    )
  )

  return (
    <Panel
      title="Withdrawals"
      actions={
        <>
          <SegmentedControl
            label="Withdrawal kind"
            options={
              origin.vm_type === "bitcoin-vm"
                ? WITHDRAWAL_FILTERS.slice(0, 2)
                : WITHDRAWAL_FILTERS
            }
            value={kind}
            onChange={setKind}
          />
          {controls(withdrawals?.pagination.next_cursor)}
        </>
      }
    >
      <DataTable
        columns={withdrawalColumns(origin.chain, lookup)}
        rows={withdrawals?.withdrawals}
        rowKey={(withdrawal) => `${withdrawal.tx_hash}:${withdrawal.log_index}`}
        empty="No withdrawals"
        pending={isPlaceholderData}
        error={error}
      />
    </Panel>
  )
}

function Depository({
  origin,
  address,
}: {
  origin: OriginChain
  address: string
}) {
  const queries = chainQueries.depository(origin.chain, address)
  const { data: response, error } = useQuery(queries.state())
  const state = response?.state
  const configuration = state?.snapshot?.configuration
  const addressItem = (label: string, address?: string | null) => ({
    label,
    value: address && (
      <AccountLink address={address} chain={origin.chain} full />
    ),
  })

  return (
    <>
      <Tokens origin={origin} address={address} />
      <Deposits origin={origin} address={address} />
      <Withdrawals origin={origin} address={address} />
      <EventPanel
        title="Admin Events"
        events={queries.events}
        columns={eventColumns({ chain: origin.chain })}
      />
      <ConfigurationPanel
        response={response}
        error={error}
        items={[
          addressItem("contract", response?.contract_address),
          addressItem("owner", configuration?.owner),
          addressItem("pending_owner", configuration?.pending_owner),
          addressItem("allocator", configuration?.allocator),
          ...(configuration?.usdc
            ? [
                addressItem("usdc", configuration.usdc),
                {
                  label: "deposits_enabled",
                  value: configuration.deposits_enabled ? "true" : "false",
                },
              ]
            : []),
        ]}
      />
    </>
  )
}

export default function ChainsPage() {
  const { chain = "", depository } = useParams()
  const { chains, error } = useOriginChains()

  if (!chain && chains) {
    const stored = readStorage(STORED_CHAIN)
    const fallback =
      chains.find((option) => option.chain === stored) ??
      chains.find((option) => option.chain === DEFAULT_CHAIN) ??
      chains[0]
    if (fallback) return <Navigate to={chainPath(fallback.chain)} replace />
  }

  const origin = chains?.find((option) => option.chain === chain)
  const gateway = depository === "gateway" && !!origin?.gateway_depository
  if (origin && depository && !gateway)
    return <Navigate to={chainPath(chain)} replace />
  const address =
    (gateway ? origin?.gateway_depository : origin?.depository) ?? ""

  return (
    <>
      {chains || !error ? (
        <DepositoryPicker
          chains={chains}
          chain={chain}
          origin={origin}
          address={address}
          gateway={gateway}
        />
      ) : null}
      {origin ? (
        <Fragment key={`${chain}:${address}`}>
          <ChainCharts
            chain={origin.chain}
            depository={address}
            enabled={!origin.deprecated}
          />
          <Depository origin={origin} address={address} />
        </Fragment>
      ) : chains || error ? (
        <Panel title="Depository">
          <EmptyState>
            {!chains ? (
              <LoadState error={error} />
            ) : chain ? (
              "No indexed depository on this chain"
            ) : (
              "No depositories"
            )}
          </EmptyState>
        </Panel>
      ) : null}
    </>
  )
}
