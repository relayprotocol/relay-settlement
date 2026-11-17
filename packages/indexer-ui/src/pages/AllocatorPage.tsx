import { useQuery } from "@tanstack/react-query"
import { allocatorQueries } from "../api/queries"
import type {
  IndexedContractEvent,
  PayloadBuilderConfiguration,
  Suspension,
} from "../api/schema"
import {
  addressItem,
  ConfigurationPanel,
  configuredAddress,
  dependency,
} from "../components/contract"
import { EventPanel } from "../components/events"
import {
  AccountLink,
  AddressLink,
  ChainLink,
  HashText,
  LabeledAddress,
  TxLink,
} from "../components/links"
import { ListPager, useListPages } from "../components/pagination"
import {
  Badge,
  DataTable,
  Muted,
  Panel,
  RelativeTime,
  SearchInput,
  TitleCount,
  type Column,
} from "../components/ui"
import { useLabels } from "../labels"
import { useSearch } from "../search"
import { formatBytes, formatNumber } from "../utils"

const ALLOCATOR_EVENT_KINDS = [
  "payload_builder_set",
  "suspended",
  "unsuspended",
  "hub_set",
  "oracle_set",
  "gas_paid",
  "signer_added",
  "signer_removed",
  "threshold_changed",
  "ownership_transfer_started",
  "ownership_transferred",
]

const BUILDER_COLUMNS: Column<PayloadBuilderConfiguration>[] = [
  {
    cell: (builder) => (
      <ChainLink chain={builder.chain} depository={builder.depository} />
    ),
    header: "Chain",
    title: "Depository chain",
    sortValue: (builder) => builder.chain,
  },
  {
    cell: (builder) => (
      <AccountLink address={builder.depository} chain={builder.chain} full />
    ),
    header: "Depository",
    title: "Depository address",
  },
  {
    cell: (builder) => {
      const address = configuredAddress(builder.builder)
      return address ? <AddressLink address={address} /> : <Muted>Unset</Muted>
    },
    header: "Builder",
    title: "Payload builder contract",
    sortValue: (builder) => configuredAddress(builder.builder),
  },
]

function PayloadBuilders({
  builders,
  error,
}: {
  builders?: PayloadBuilderConfiguration[]
  error?: Error | null
}) {
  const labels = useLabels()
  const search = useSearch()
  const query = search.query.toLowerCase()
  const matches = builders?.filter(
    (builder) =>
      !query ||
      builder.chain.includes(query) ||
      labels.chain(builder.chain).toLowerCase().includes(query) ||
      builder.depository.toLowerCase() === query
  )
  const pages = useListPages(matches?.length, query)
  return (
    <Panel
      title="Payload Builders"
      badge={
        builders && matches ? (
          <TitleCount
            label="builders"
            shown={matches.length}
            total={builders.length}
            filtered={!!query}
          />
        ) : null
      }
      actions={
        <>
          <SearchInput placeholder="Search chains" {...search.input} />
          <ListPager pages={pages} />
        </>
      }
    >
      <DataTable
        columns={BUILDER_COLUMNS}
        rows={matches}
        page={pages}
        defaultSort={{ column: 0, descending: false }}
        rowKey={(builder) => `${builder.chain}:${builder.depository}`}
        empty="No payload builders"
        error={error}
      />
    </Panel>
  )
}

const SUSPENSION_COLUMNS: Column<Suspension>[] = [
  {
    cell: (suspension) => <LabeledAddress address={suspension.alias} />,
    header: "Alias",
    title: "Spender alias on the Hub",
  },
  {
    cell: (suspension) =>
      suspension.suspended ? (
        <Badge tone="warning" title="Alias cannot withdraw">
          Suspended
        </Badge>
      ) : (
        <Badge tone="success" title="Alias can withdraw">
          Active
        </Badge>
      ),
    header: "Status",
    title: "Latest suspension state",
    sortValue: (suspension) => (suspension.suspended ? 0 : 1),
  },
  {
    align: "right",
    cell: (suspension) => <RelativeTime value={suspension.block_timestamp} />,
    header: "Changed",
    title: "Latest suspension change",
    sortValue: (suspension) => suspension.block_timestamp,
  },
  {
    cell: (suspension) => <TxLink hash={suspension.tx_hash} />,
    header: "Transaction",
    title: "Suspension transaction hash",
  },
]

function SuspendedAliases() {
  const { data, error } = useQuery(allocatorQueries.suspensions())
  const labels = useLabels()
  const search = useSearch()
  const query = search.query.toLowerCase()
  const suspensions = data?.suspensions
  const matches = suspensions?.filter(
    (suspension) =>
      !query ||
      suspension.alias.toLowerCase().includes(query) ||
      labels.address(suspension.alias)?.toLowerCase().includes(query)
  )
  const pages = useListPages(matches?.length, query)
  return (
    <Panel
      title="Suspended Aliases"
      badge={
        suspensions && matches ? (
          <TitleCount
            label="aliases"
            shown={matches.length}
            total={suspensions.length}
            filtered={!!query}
          />
        ) : null
      }
      actions={
        <>
          <SearchInput placeholder="Search aliases" {...search.input} />
          <ListPager pages={pages} />
        </>
      }
    >
      <DataTable
        columns={SUSPENSION_COLUMNS}
        rows={matches}
        page={pages}
        rowKey={(suspension) => suspension.alias}
        defaultSort={{ column: 1, descending: false }}
        empty="No suspended aliases"
        error={error}
      />
    </Panel>
  )
}

const PAYLOAD_COLUMNS: Column<IndexedContractEvent>[] = [
  {
    cell: (event) => <RelativeTime value={event.block_timestamp} />,
    header: "Time",
    title: "Payload event block time",
  },
  {
    cell: ({ data }) =>
      data.kind === "payload_built" ? (
        <HashText value={data.withdraw_request_hash} />
      ) : null,
    header: "Withdraw request",
    title: "Withdraw request hash",
  },
  {
    cell: ({ data }) =>
      data.kind === "payload_built" ? (
        <HashText value={data.payload_hash} />
      ) : null,
    header: "Payload",
    title: "Payload hash",
  },
  {
    align: "right",
    cell: ({ data }) =>
      data.kind === "payload_built" ? formatBytes(data.payload_bytes) : null,
    header: "Size",
    title: "Payload size",
  },
  {
    align: "right",
    cell: ({ data }) =>
      data.kind === "payload_built" ? formatNumber(data.hash_count) : null,
    header: "Hashes",
    title: "Hashes requiring signatures",
  },
  {
    cell: (event) => <TxLink hash={event.tx_hash} />,
    header: "Transaction",
    title: "Payload transaction hash",
  },
]

export default function AllocatorPage() {
  const { data: response, error } = useQuery(allocatorQueries.state())
  const state = response?.state
  const configuration = state?.snapshot?.configuration

  return (
    <>
      <EventPanel
        title="Payloads"
        events={allocatorQueries.events}
        kind="payload_built"
        columns={PAYLOAD_COLUMNS}
        empty="No payloads built"
      />
      <PayloadBuilders
        builders={response && (configuration?.builders ?? [])}
        error={error}
      />
      <SuspendedAliases />
      <EventPanel
        title="Admin Events"
        events={allocatorQueries.events}
        kinds={ALLOCATOR_EVENT_KINDS}
      />
      <ConfigurationPanel
        response={response}
        error={error}
        items={[
          addressItem("contract", response?.contract_address),
          addressItem("owner", configuration?.owner),
          addressItem("pending_owner", configuration?.pending_owner),
          addressItem("hub", configuration?.hub),
          addressItem("oracle_multisig", configuration?.oracle_multisig),
          addressItem(
            "withdraw_gas_payer",
            dependency(response, "withdraw_gas_payer")?.address
          ),
        ]}
      />
    </>
  )
}
