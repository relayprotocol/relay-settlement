import { useQuery } from "@tanstack/react-query"
import { chainQueries } from "../api/queries"
import type { DepositoryStatsBucket } from "../api/schema"
import { ActivityChart, type ActivityMeasures } from "./ActivityChart"
import { BalancePanel } from "./charts"

type Counts = Pick<
  DepositoryStatsBucket,
  "deposits" | "withdrawals" | "deposits_usd" | "withdrawals_usd"
>

const sum = (buckets: Counts[]) =>
  buckets.reduce<Counts>(
    (total, item) => ({
      deposits: total.deposits + item.deposits,
      deposits_usd: total.deposits_usd + item.deposits_usd,
      withdrawals: total.withdrawals + item.withdrawals,
      withdrawals_usd: total.withdrawals_usd + item.withdrawals_usd,
    }),
    { deposits: 0, deposits_usd: 0, withdrawals: 0, withdrawals_usd: 0 }
  )

const MEASURES: ActivityMeasures<Counts> = {
  count: {
    total: (counts) => counts.deposits + counts.withdrawals,
    series: [
      { label: "Deposits", value: (counts) => counts.deposits },
      { label: "Withdrawals", value: (counts) => counts.withdrawals },
    ],
  },
  volume: {
    total: (counts) => counts.deposits_usd + counts.withdrawals_usd,
    series: [
      { label: "Deposits", value: (counts) => counts.deposits_usd },
      { label: "Withdrawals", value: (counts) => counts.withdrawals_usd },
    ],
  },
}

export function ChainCharts({
  chain,
  depository,
  enabled = true,
}: {
  chain: string
  depository: string
  enabled?: boolean
}) {
  const custody = useQuery({
    ...chainQueries.activityStats(chain, depository),
    enabled,
  })
  return (
    <>
      <ActivityChart
        title="Activity"
        enabled={enabled}
        measures={MEASURES}
        sum={sum}
        query={(window) =>
          chainQueries.activityStats(chain, depository, window)
        }
      />
      <BalancePanel
        title="Balance"
        stats={enabled ? custody.data : null}
        error={enabled ? custody.error : null}
      />
    </>
  )
}
