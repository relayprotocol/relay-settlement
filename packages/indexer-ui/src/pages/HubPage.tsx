import { useQuery } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import { hubQueries } from "../api/queries"
import type {
  HubWallet,
  IndexedRoleChange,
  RoleConfiguration,
  Token,
} from "../api/schema"
import { addressItem, ConfigurationPanel } from "../components/contract"
import {
  AddressLink,
  HashText,
  LabeledAddress,
  OriginChain,
  TokenLink,
  TxLink,
} from "../components/links"
import {
  CursorPager,
  ListPager,
  useCursorPages,
  useListPages,
} from "../components/pagination"
import { HubCharts } from "../components/HubCharts"
import { TransfersPanel } from "../components/transfers"
import { Usd, UsdPrice } from "../components/Usd"
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
  TitleCount,
  type Column,
} from "../components/ui"
import { Tooltip } from "../components/Tooltip"
import { HUB_ROLES } from "../roles"
import { useSearch } from "../search"
import {
  capitalize,
  displayTokenLabel,
  formatNumber,
  shortTokenId,
} from "../utils"

const ROLE_CHANGE_TONES = {
  admin_changed: "primary",
  granted: "success",
  revoked: "neutral",
} as const

const ROLE_CHANGE_COLUMNS: Column<IndexedRoleChange>[] = [
  {
    cell: (change) => <RelativeTime value={change.block_timestamp} />,
    header: "Time",
    title: "Role change block time",
  },
  {
    cell: (change) => (
      <Badge tone={ROLE_CHANGE_TONES[change.kind]}>
        {capitalize(change.kind.replace("_", " "))}
      </Badge>
    ),
    header: "Change",
    title: "Role change type",
  },
  {
    cell: (change) =>
      change.account ? (
        <AddressLink full address={change.account} />
      ) : (
        <Muted />
      ),
    header: "Account",
    title: "Account affected by role change",
  },
  {
    cell: (change) =>
      change.sender ? <AddressLink address={change.sender} /> : <Muted />,
    header: "Sender",
    title: "Transaction sender",
  },
  {
    cell: (change) => <TxLink hash={change.tx_hash} />,
    header: "Transaction",
    title: "Role change transaction hash",
  },
]

const tokenLabel = (token: Token) => displayTokenLabel(token.name, token.symbol)

const sortTokens = (tokens: Token[]) =>
  tokens.toSorted((a, b) => tokenLabel(a).localeCompare(tokenLabel(b)))

function Tokens({ tokens, error }: { tokens?: Token[]; error?: Error | null }) {
  const search = useSearch()
  const query = search.query.toLowerCase()
  const matches = tokens?.filter(
    (token) =>
      !query ||
      token.token_id === query ||
      [token.symbol, token.name].some((value) =>
        value?.toLowerCase().includes(query)
      )
  )
  const pages = useListPages(matches?.length, query)

  const columns: Column<Token>[] = [
    {
      cell: (token) => (
        <TokenLink
          tokenId={token.token_id}
          name={token.name}
          symbol={token.symbol}
        />
      ),
      header: "Token",
      title: "Token name or symbol",
    },
    {
      cell: (token) => <HashText value={token.token_id} short={shortTokenId} />,
      header: "ID",
      title: "Hub token ID",
    },
    {
      cell: (token) => (
        <OriginChain id={token.origin_chain_id} vmType={token.origin_vm_type} />
      ),
      header: "Chain",
      title: "Origin chain",
    },
    {
      align: "right",
      cell: (token) => <UsdPrice tokenId={token.token_id} />,
      header: "Price",
      title: "Token price in USD",
    },
    {
      align: "right",
      cell: (token) =>
        token.total_supply == null ? (
          <Muted />
        ) : (
          <Amount value={token.total_supply} decimals={token.decimals} />
        ),
      header: "Supply",
      title: "Hub total supply",
    },
  ]

  return (
    <Panel
      title="Tokens"
      badge={
        tokens && matches ? (
          <TitleCount
            label="tokens"
            shown={matches.length}
            total={tokens.length}
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
        columns={columns}
        rows={matches}
        page={pages}
        rowKey={(token) => token.token_id}
        empty="No tokens"
        error={error}
      />
    </Panel>
  )
}

function Wallets() {
  const search = useSearch()
  const query = search.query.toLowerCase()
  const valid = /^0x[0-9a-f]{40}$/.test(query)
  const pages = useCursorPages(query)
  const list = useQuery({
    ...hubQueries.wallets(pages.cursor),
    enabled: !query,
  })
  const lookup = useQuery({ ...hubQueries.wallet(query), enabled: valid })
  const rows = query
    ? valid
      ? lookup.data && [lookup.data.wallet]
      : []
    : list.data?.wallets

  return (
    <Panel
      title="Wallets"
      actions={
        <>
          <SearchInput
            aria-label="Search wallet address"
            placeholder="Search wallet address"
            invalid={query !== "" && !valid}
            {...search.input}
          />
          {!query && (
            <CursorPager
              pages={pages}
              next={list.data?.pagination.next_cursor}
            />
          )}
        </>
      }
    >
      <DataTable<HubWallet>
        columns={[
          {
            cell: (wallet) => <LabeledAddress address={wallet.account} />,
            header: "Account",
            title: "Wallet address",
          },
          {
            align: "right",
            cell: (wallet) => formatNumber(wallet.tokens.total),
            header: "Tokens",
            title: "Tokens held",
          },
          {
            align: "right",
            cell: (wallet) => (
              <Tooltip
                content={`Priced wallet balance - ${wallet.tokens.total - wallet.tokens.priced} tokens excluded`}
              >
                <span>
                  {wallet.balance_usd == null ? (
                    <Muted />
                  ) : (
                    <Usd value={wallet.balance_usd} />
                  )}
                </span>
              </Tooltip>
            ),
            header: "Balance",
            title: "Priced wallet balance in USD",
          },
          {
            cell: (wallet) => <RelativeTime value={wallet.last_active_at} />,
            header: "Active",
            title: "Latest mint, burn, or transfer",
          },
        ]}
        rows={rows}
        error={query ? (valid ? lookup.error : null) : list.error}
        pending={!query && list.isPlaceholderData}
        rowKey={(wallet) => wallet.account}
        empty={
          query && !valid ? "Enter a complete wallet address" : "No wallets"
        }
      />
    </Panel>
  )
}

function Roles({
  roles,
  error,
}: {
  roles?: RoleConfiguration[]
  error?: Error | null
}) {
  const changes = useQuery(hubQueries.roleChanges()).data
  return (
    <Panel title="Roles">
      {roles ? (
        <ul className="divide-y divide-line">
          {HUB_ROLES.map(({ hash, name }) => {
            const members =
              roles.find((role) => role.role.toLowerCase() === hash)?.members ??
              []
            const granted = members.filter((member) => member.granted)
            const missing = members.filter(
              (member) => member.required && !member.granted
            )
            const history = changes
              ?.filter((change) => change.role.toLowerCase() === hash)
              .toSorted(
                (a, b) =>
                  b.block_number - a.block_number || b.log_index - a.log_index
              )
            return (
              <li key={hash}>
                <div className="flex flex-col gap-4 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Tooltip content={hash}>
                      <h3 className="font-semibold">{name}</h3>
                    </Tooltip>
                    <Badge title="Accounts holding this role">
                      {granted.length} granted
                    </Badge>
                    {missing.length ? (
                      <Badge
                        tone="error"
                        title="Configured accounts lacking this role"
                      >
                        {missing.length} missing
                      </Badge>
                    ) : null}
                  </div>
                  {granted.length || missing.length ? (
                    <ul className="flex flex-col gap-1 text-sm">
                      {[...missing, ...granted].map((member) => (
                        <li
                          key={member.account}
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
                        >
                          <LabeledAddress address={member.account} />
                          {member.granted ? null : (
                            <Badge tone="error" title="Account lacks this role">
                              Missing
                            </Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-xs text-fg-muted">No members</span>
                  )}
                </div>
                {history?.length ? (
                  <details className="group border-t border-line">
                    <summary
                      aria-label={`History for ${name}`}
                      className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-sm text-fg-subtle outline-none select-none hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-primary-fg focus-visible:ring-inset [&::-webkit-details-marker]:hidden"
                    >
                      <ChevronRight
                        aria-hidden
                        className="size-4 text-fg-subtle transition-transform group-open:rotate-90"
                      />
                      History
                      <span className="rounded-full bg-element px-2 py-0.5 text-xs text-fg-subtle tabular-nums">
                        {formatNumber(history.length)}
                      </span>
                    </summary>
                    <div className="border-t border-line">
                      <DataTable
                        columns={ROLE_CHANGE_COLUMNS}
                        rows={history}
                        rowKey={(change) =>
                          `${change.tx_hash}-${change.log_index}`
                        }
                      />
                    </div>
                  </details>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <EmptyState>
          <LoadState error={error} />
        </EmptyState>
      )}
    </Panel>
  )
}

export default function HubPage() {
  const { data: hub, error } = useQuery(hubQueries.state())
  const { data: tokens, error: tokensError } = useQuery({
    ...hubQueries.tokens(),
    select: sortTokens,
  })

  return (
    <>
      <HubCharts />
      <Wallets />
      <Tokens tokens={tokens} error={tokensError} />
      <TransfersPanel title="Ledger" />
      <Roles
        roles={hub && (hub.state?.snapshot?.configuration.roles ?? [])}
        error={error}
      />
      <ConfigurationPanel
        response={hub}
        error={error}
        items={[
          addressItem("contract", hub?.contract_address),
          {
            label: "role_grants",
            value:
              hub?.state?.snapshot &&
              formatNumber(
                hub.state.snapshot.configuration.roles
                  .flatMap((role) => role.members)
                  .filter((member) => member.granted).length
              ),
          },
          { label: "tokens", value: tokens && formatNumber(tokens.length) },
        ]}
      />
    </>
  )
}
