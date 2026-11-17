import { useQuery } from "@tanstack/react-query"
import { hubQueries } from "../api/queries"
import type { TokenHolder } from "../api/schema"
import { formatNumber, formatShare } from "../utils"
import { AddressLink } from "./links"
import { CursorPager, useCursorPages } from "./pagination"
import { UsdValue } from "./Usd"
import { Amount, DataTable, Muted, Panel } from "./ui"

export default function Holders({ tokenId }: { tokenId: string }) {
  const pages = useCursorPages()
  const {
    data: holders,
    error,
    isPlaceholderData,
  } = useQuery(hubQueries.holders(tokenId, pages.cursor))
  const supply = useQuery(hubQueries.tokenState(tokenId)).data?.state
    ?.total_supply
  const decimals = holders?.token.decimals

  return (
    <Panel
      title="Holders"
      actions={
        <CursorPager pages={pages} next={holders?.pagination.next_cursor} />
      }
    >
      <DataTable<TokenHolder>
        rows={holders?.balances}
        rowKey={(holder) => holder.account}
        empty="No holders"
        pending={isPlaceholderData}
        error={error}
        columns={[
          {
            cell: (holder) => <AddressLink address={holder.account} />,
            header: "Account",
            title: "Holder account",
          },
          {
            align: "right",
            cell: (holder) => (
              <Amount value={holder.balance} decimals={decimals} />
            ),
            header: "Balance",
            title: "Token amount held",
          },
          {
            align: "right",
            cell: (holder) => (
              <UsdValue
                tokenId={tokenId}
                amount={holder.balance}
                decimals={decimals}
              />
            ),
            header: "Value",
            title: "Balance in USD",
          },
          {
            align: "right",
            cell: (holder) =>
              supply ? formatShare(holder.balance, supply) : <Muted />,
            header: "Share",
            title: "Share of total supply",
          },
          {
            align: "right",
            cell: (holder) => formatNumber(holder.block_number),
            header: "Block",
            title: "Balance read block",
          },
        ]}
      />
    </Panel>
  )
}
