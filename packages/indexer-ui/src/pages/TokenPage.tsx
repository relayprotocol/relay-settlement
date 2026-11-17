import { useParams } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { ApiError } from "../api/client"
import { hubQueries } from "../api/queries"
import Holders from "../components/Holders"
import { TransfersPanel } from "../components/transfers"
import { UsdPrice, UsdValue } from "../components/Usd"
import { AddressLink, OriginChain, OriginChainIcon } from "../components/links"
import {
  Amount,
  EmptyState,
  KeyValuePanel,
  Muted,
  Panel,
} from "../components/ui"
import { displayTokenLabel, formatNumber } from "../utils"

export default function TokenPage() {
  const { tokenId = "" } = useParams()
  const { data, error } = useQuery(hubQueries.token(tokenId))
  const token = data?.token
  const tokenState = useQuery(hubQueries.tokenState(tokenId))
  const state = tokenState.data?.state
  const pending = <Muted>{tokenState.error ? "-" : "..."}</Muted>

  if (error instanceof ApiError && error.status < 500)
    return (
      <Panel title="Token">
        <EmptyState>{error.detail ?? error.message}</EmptyState>
      </Panel>
    )

  return (
    <>
      <KeyValuePanel
        title={
          token ? (
            <span className="inline-flex items-center gap-1.5">
              <OriginChainIcon id={token.origin_chain_id} />
              {displayTokenLabel(token.name, token.symbol)}
            </span>
          ) : (
            "Token"
          )
        }
        error={error}
        items={
          token && [
            { label: "token_id", value: token.token_id },
            { label: "symbol", value: token.symbol ?? <Muted /> },
            { label: "name", value: token.name ?? <Muted /> },
            { label: "decimals", value: token.decimals ?? <Muted /> },
            {
              label: "origin_chain",
              value: (
                <OriginChain
                  id={token.origin_chain_id}
                  vmType={token.origin_vm_type}
                />
              ),
            },
            {
              label: "origin_vm_type",
              value: token.origin_vm_type ?? <Muted />,
            },
            { label: "origin_asset", value: token.origin_asset ?? <Muted /> },
            {
              label: "erc20_view",
              value: token.erc20_view ? (
                <AddressLink address={token.erc20_view} full />
              ) : (
                <Muted />
              ),
            },
            {
              label: "total_supply",
              value: state ? (
                <Amount value={state.total_supply} decimals={token.decimals} />
              ) : (
                pending
              ),
            },
            {
              label: "price",
              value: <UsdPrice tokenId={token.token_id} />,
            },
            {
              label: "total_supply_value",
              value: state ? (
                <UsdValue
                  tokenId={token.token_id}
                  amount={state.total_supply}
                  decimals={token.decimals}
                />
              ) : (
                pending
              ),
            },
            {
              label: "holders",
              value: state ? formatNumber(state.indexed_holder_count) : pending,
            },
            {
              label: "transfers",
              value: !state ? (
                pending
              ) : state.indexed_transfer_count == null ? (
                <Muted />
              ) : (
                formatNumber(state.indexed_transfer_count)
              ),
              hint:
                state && state.indexed_transfer_count == null
                  ? "Statistics backfill in progress"
                  : undefined,
            },
            {
              label: "state_block",
              value: state ? formatNumber(state.block_number) : pending,
            },
          ]
        }
      />
      <Holders key={tokenId} tokenId={tokenId} />
      <TransfersPanel
        key={`activity:${tokenId}`}
        title="Activity"
        tokenId={tokenId}
      />
    </>
  )
}
