import { useParams } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { ApiError } from "../api/client"
import { allocatorQueries, hubQueries } from "../api/queries"
import type { WalletBalance } from "../api/schema"
import {
  AccountLink,
  CopyOverlay,
  OriginChain,
  TokenLink,
} from "../components/links"
import { CursorPager, useCursorPages } from "../components/pagination"
import { TransfersPanel } from "../components/transfers"
import { UsdValue } from "../components/Usd"
import { Amount, Badge, DataTable, EmptyState, Panel } from "../components/ui"
import { HUB_CHAIN } from "../explorers"
import { useLabels } from "../labels"
import { heldRoles } from "../roles"
import { cx, formatNumber } from "../utils"
import { isSuspended } from "../wallets"

export default function WalletPage() {
  const { address = "" } = useParams()
  const labels = useLabels()
  const pages = useCursorPages(address)
  const { data, error, isPlaceholderData } = useQuery(
    hubQueries.walletBalances(address, pages.cursor)
  )
  const label = labels.address(address)
  const roles = heldRoles(
    useQuery(hubQueries.state()).data?.state?.snapshot?.configuration.roles ??
      [],
    address
  )
  const suspended = isSuspended(
    useQuery(allocatorQueries.suspensions()).data?.suspensions ?? [],
    address
  )
  const invalid = error instanceof ApiError && error.status < 500
  const account = (
    <span className={cx("font-normal", label && "md:order-1")}>
      <CopyOverlay value="md">
        <AccountLink address={address} chain={HUB_CHAIN} full />
      </CopyOverlay>
    </span>
  )

  return (
    <>
      <Panel
        title={
          <span className="flex flex-col gap-1 [--flow-gap:--spacing(3)] md:flex-row md:flex-wrap md:items-center md:gap-x-(--flow-gap)">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 md:contents">
              {label ? <span>{label}</span> : account}
              {roles.length || suspended ? (
                <span className="flex flex-wrap items-center gap-2 md:order-2">
                  {roles.map((role) => (
                    <Badge key={role.hash} tone="primary">
                      {role.name}
                    </Badge>
                  ))}
                  {suspended ? (
                    <Badge tone="warning" title="Alias cannot withdraw">
                      Suspended
                    </Badge>
                  ) : null}
                </span>
              ) : null}
            </span>
            {label ? account : null}
          </span>
        }
        actions={
          invalid ? null : (
            <CursorPager pages={pages} next={data?.pagination.next_cursor} />
          )
        }
      >
        {invalid ? (
          <EmptyState>{error.detail ?? error.message}</EmptyState>
        ) : (
          <DataTable<WalletBalance>
            rows={data?.balances}
            rowKey={(balance) => balance.token_id}
            empty="No balances"
            pending={isPlaceholderData}
            error={error}
            columns={[
              {
                cell: (balance) => (
                  <TokenLink
                    tokenId={balance.token_id}
                    name={balance.name}
                    symbol={balance.symbol}
                  />
                ),
                header: "Token",
                title: "Token name or symbol",
              },
              {
                cell: (balance) => (
                  <OriginChain
                    id={balance.origin_chain_id}
                    vmType={balance.origin_vm_type}
                  />
                ),
                header: "Chain",
                title: "Origin chain",
              },
              {
                align: "right",
                cell: (balance) => (
                  <Amount value={balance.balance} decimals={balance.decimals} />
                ),
                header: "Balance",
                title: "Token amount held",
              },
              {
                align: "right",
                cell: (balance) => (
                  <UsdValue
                    tokenId={balance.token_id}
                    amount={balance.balance}
                    decimals={balance.decimals}
                  />
                ),
                header: "Value",
                title: "Balance in USD",
              },
              {
                align: "right",
                cell: (balance) => formatNumber(balance.block_number),
                header: "Block",
                title: "Balance read block",
              },
            ]}
          />
        )}
      </Panel>
      {invalid ? null : (
        <TransfersPanel key={address} title="Activity" account={address} />
      )}
    </>
  )
}
