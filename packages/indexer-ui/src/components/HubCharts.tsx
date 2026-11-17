import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { hubQueries } from "../api/queries"
import type { TransferStats, TransferStatsBucket } from "../api/schema"
import { useOriginChains } from "../origins"
import { ActivityChart, type ActivityMeasures } from "./ActivityChart"
import { BalancePanel } from "./charts"
import { Picker, chainOptions } from "./Picker"

type Counts = Pick<
  TransferStatsBucket,
  "transfers" | "mints" | "burns" | "transfers_usd" | "mints_usd" | "burns_usd"
>

const sum = (buckets: Counts[]) =>
  buckets.reduce<Counts>(
    (total, item) => ({
      burns: total.burns + item.burns,
      burns_usd: total.burns_usd + item.burns_usd,
      mints: total.mints + item.mints,
      mints_usd: total.mints_usd + item.mints_usd,
      transfers: total.transfers + item.transfers,
      transfers_usd: total.transfers_usd + item.transfers_usd,
    }),
    {
      burns: 0,
      burns_usd: 0,
      mints: 0,
      mints_usd: 0,
      transfers: 0,
      transfers_usd: 0,
    }
  )

const MEASURES: ActivityMeasures<Counts> = {
  count: {
    total: (counts) => counts.transfers,
    series: [
      {
        label: "Transfers",
        value: (counts) => counts.transfers - counts.mints - counts.burns,
      },
      { label: "Mints", value: (counts) => counts.mints },
      { label: "Burns", value: (counts) => counts.burns },
    ],
  },
  volume: {
    total: (counts) => counts.transfers_usd,
    series: [
      {
        label: "Transfers",
        value: (counts) =>
          Math.max(
            0,
            counts.transfers_usd - counts.mints_usd - counts.burns_usd
          ),
      },
      { label: "Mints", value: (counts) => counts.mints_usd },
      { label: "Burns", value: (counts) => counts.burns_usd },
    ],
  },
}

export function HubCharts() {
  const { data, error } = useQuery(hubQueries.transferStats())
  return (
    <>
      <ActivityChart
        title="Activity"
        measures={MEASURES}
        sum={sum}
        query={hubQueries.transferStats}
      />
      <HubBalance stats={data} error={error} />
    </>
  )
}

function HubBalance({
  stats,
  error,
}: {
  stats?: TransferStats
  error?: Error | null
}) {
  const [chain, setChain] = useState("")
  const { chains } = useOriginChains()
  const deprecated = chains?.some(
    (origin) => origin.chain === chain && origin.deprecated
  )
  const origin = useQuery({
    ...hubQueries.originStats(chain),
    enabled: chain !== "" && !deprecated,
  })
  return (
    <BalancePanel
      title="Balance"
      stats={deprecated ? null : chain ? origin.data : stats}
      error={deprecated ? null : chain ? origin.error : error}
      actions={
        <Picker
          noun="chain"
          options={chainOptions(chains ?? [])}
          value={chain}
          label="Select chain"
          onChange={setChain}
          onClear={() => setChain("")}
          variant="field"
          align="end"
          className="w-44"
        />
      }
    />
  )
}
