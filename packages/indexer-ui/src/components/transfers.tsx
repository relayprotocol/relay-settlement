import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { hubQueries, type TransferFilter } from "../api/queries"
import type { Transfer, TransferKind } from "../api/schema"
import { useSearch } from "../search"
import { useTokens } from "../tokens"
import { capitalize, displayTokenLabel } from "../utils"
import { AddressLink, OriginChainIcon, TokenLink, TxLink } from "./links"
import { CursorPager, useCursorPages } from "./pagination"
import { Picker } from "./Picker"
import {
  Amount,
  Badge,
  DataTable,
  Panel,
  RelativeTime,
  SearchInput,
  SegmentedControl,
  type Column,
} from "./ui"

const TX_HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i

export const TRANSFER_KIND_TONES = {
  burn: "warning",
  mint: "success",
  transfer: "neutral",
} as const

const TRANSFER_KINDS: Array<{ label: string; value: TransferKind | "all" }> = [
  { label: "All", value: "all" },
  { label: "Transfer", value: "transfer" },
  { label: "Mint", value: "mint" },
  { label: "Burn", value: "burn" },
]

const TRANSFER_COLUMNS: Column<Transfer>[] = [
  {
    cell: (transfer) => <RelativeTime value={transfer.block_timestamp} />,
    header: "Time",
    title: "Transfer block time",
  },
  {
    cell: (transfer) => (
      <Badge tone={TRANSFER_KIND_TONES[transfer.kind]}>
        {capitalize(transfer.kind)}
      </Badge>
    ),
    header: "Kind",
    title: "Transfer type",
  },
  {
    cell: (transfer) => (
      <TokenLink
        tokenId={transfer.token_id}
        name={transfer.name}
        symbol={transfer.symbol}
      />
    ),
    header: "Token",
    title: "Token name or symbol",
  },
  {
    align: "right",
    cell: (transfer) => (
      <Amount value={transfer.amount} decimals={transfer.decimals} />
    ),
    header: "Amount",
    title: "Token amount transferred",
  },
  {
    cell: (transfer) => <AddressLink address={transfer.from} />,
    header: "From",
    title: "Sender account",
  },
  {
    cell: (transfer) => <AddressLink address={transfer.to} />,
    header: "To",
    title: "Recipient account",
  },
  {
    cell: (transfer) => <TxLink hash={transfer.tx_hash} />,
    header: "Transaction",
    title: "Transfer transaction hash",
  },
]

const TOKENLESS_COLUMNS = TRANSFER_COLUMNS.filter(
  (column) => column.header !== "Token"
)

const searchFilter = (
  value: string,
  accounts: boolean
): TransferFilter | undefined => {
  if (!value) return {}
  if (TX_HASH.test(value)) return { txHash: value.toLowerCase() }
  if (accounts && ADDRESS.test(value)) return { account: value.toLowerCase() }
  return undefined
}

export function TransfersPanel({
  title,
  account,
  tokenId,
}: {
  title: string
  account?: string
  tokenId?: string
}) {
  const [kind, setKind] = useState<TransferKind | "all">("all")
  const [token, setToken] = useState("")
  const tokens = useTokens()
  const search = useSearch()
  const parsed = searchFilter(search.query, !account)
  const filter: TransferFilter = {
    account: account?.toLowerCase(),
    kind: kind === "all" ? undefined : kind,
    tokenId: tokenId ?? (token || undefined),
    ...parsed,
  }
  const pages = useCursorPages(
    [filter.account, filter.kind, filter.tokenId, filter.txHash].join(":")
  )
  const {
    data: transfers,
    error,
    isPlaceholderData,
  } = useQuery(hubQueries.transfers(filter, pages.cursor))
  const tokenOptions = [...(tokens?.values() ?? [])]
    .map((option) => ({
      hint: option.origin_asset ?? option.token_id,
      icon: <OriginChainIcon id={option.origin_chain_id} />,
      id: option.token_id,
      name: displayTokenLabel(option.name, option.symbol),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  return (
    <Panel
      title={title}
      actions={
        <>
          <SegmentedControl
            label="Transfer kind"
            options={TRANSFER_KINDS}
            value={kind}
            onChange={setKind}
          />
          {tokenId ? null : (
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
          )}
          <SearchInput
            aria-label={
              account ? "Search transaction hash" : "Search hash or account"
            }
            invalid={search.query !== "" && !parsed}
            placeholder={account ? "Search hash" : "Search hash or account"}
            {...search.input}
          />
          <CursorPager pages={pages} next={transfers?.pagination.next_cursor} />
        </>
      }
    >
      <DataTable
        columns={tokenId ? TOKENLESS_COLUMNS : TRANSFER_COLUMNS}
        rows={transfers?.transfers}
        rowKey={(transfer) => `${transfer.tx_hash}-${transfer.log_index}`}
        empty="No transfers"
        pending={isPlaceholderData}
        error={error}
      />
    </Panel>
  )
}
