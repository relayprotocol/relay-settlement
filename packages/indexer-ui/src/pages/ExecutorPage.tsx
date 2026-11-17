import { useQuery } from "@tanstack/react-query"
import { executorQueries } from "../api/queries"
import type { IndexedContractEvent } from "../api/schema"
import {
  addressItem,
  ConfigurationPanel,
  dependency,
  RolesPanel,
} from "../components/contract"
import { EventPanel, TokenAmount } from "../components/events"
import { AddressLink, HashText, TxLink } from "../components/links"
import { RelativeTime, type Column } from "../components/ui"

const EXECUTOR_EVENT_KINDS = [
  "signer_added",
  "signer_removed",
  "threshold_changed",
  "ownership_transfer_started",
  "ownership_transferred",
]

const EXECUTION_COLUMNS: Column<IndexedContractEvent>[] = [
  {
    cell: (event) => <RelativeTime value={event.block_timestamp} />,
    header: "Time",
    title: "Execution block time",
  },
  {
    align: "right",
    cell: ({ data }) =>
      data.kind === "executor_executed" ? (
        <TokenAmount tokenId={data.token_in} amount={data.amount_in} />
      ) : null,
    header: "In",
    title: "Input amount",
  },
  {
    align: "right",
    cell: ({ data }) =>
      data.kind === "executor_executed" ? (
        <TokenAmount tokenId={data.token_out} amount={data.amount_out} />
      ) : null,
    header: "Out",
    title: "Output amount",
  },
  {
    cell: ({ data }) =>
      data.kind === "executor_executed" ? (
        <AddressLink address={data.order_address} />
      ) : null,
    header: "Order",
    title: "Order contract",
  },
  {
    cell: ({ data }) =>
      data.kind === "executor_executed" ? (
        <HashText value={data.withdraw_request_hash} />
      ) : null,
    header: "Withdraw request",
    title: "Withdraw request hash",
  },
  {
    cell: (event) => <TxLink hash={event.tx_hash} />,
    header: "Transaction",
    title: "Execution transaction hash",
  },
]

export default function ExecutorPage() {
  const { data: response, error } = useQuery(executorQueries.state())
  const state = response?.state
  const configuration = state?.snapshot?.configuration

  return (
    <>
      <EventPanel
        title="Executions"
        events={executorQueries.events}
        kind="executor_executed"
        columns={EXECUTION_COLUMNS}
        empty="No executions"
      />
      <RolesPanel
        roles={response && (configuration?.roles ?? [])}
        error={error}
      />
      <EventPanel
        title="Admin Events"
        events={executorQueries.events}
        kinds={EXECUTOR_EVENT_KINDS}
      />
      <ConfigurationPanel
        response={response}
        error={error}
        items={[
          addressItem("contract", response?.contract_address),
          addressItem("hub", configuration?.hub),
          addressItem("allocator", configuration?.allocator),
          addressItem(
            "oracle_multisig",
            dependency(response, "oracle_multisig")?.address
          ),
        ]}
      />
    </>
  )
}
