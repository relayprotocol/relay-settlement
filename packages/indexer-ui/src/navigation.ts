import {
  Activity,
  BellRing,
  Blocks,
  Box,
  ChartPie,
  CircleDollarSign,
  Cpu,
  Layers,
  Lens,
  type LucideIcon,
} from "lucide-react"
import {
  allocatorQueries,
  executorQueries,
  hubQueries,
  indexerQueries,
  oracleQueries,
  poolQueries,
  priceOracleQueries,
  priceQueries,
  xerc20Queries,
} from "./api/queries"
import type { Prefetch } from "./prefetch"
import {
  ADMIN_EVENT_KINDS,
  LOCKBOX_EVENT_KINDS,
  storedPool,
  toPools,
} from "./pools"

type Section = {
  end?: boolean
  icon: LucideIcon
  label: string
  path: string
  prefetch: Prefetch
}

export const SECTIONS: Section[] = [
  {
    end: true,
    icon: Activity,
    label: "Indexer",
    path: "/",
    prefetch: (queryClient) => [
      queryClient.query(indexerQueries.status()),
      queryClient.query(indexerQueries.config()),
      queryClient.query(indexerQueries.database()),
      queryClient.query(indexerQueries.rescans(1)),
    ],
  },
  {
    icon: Box,
    label: "Chains",
    path: "/chains",
    prefetch: (queryClient) => [
      queryClient.query(indexerQueries.status()),
      queryClient.query(indexerQueries.config()),
      queryClient.query(hubQueries.tokens()),
    ],
  },
  {
    icon: Layers,
    label: "Hub",
    path: "/hub",
    prefetch: (queryClient) => [
      queryClient.query(hubQueries.state()),
      queryClient.query(hubQueries.tokens()),
      queryClient.query(hubQueries.transfers({})),
      queryClient.query(hubQueries.transferStats()),
    ],
  },
  {
    icon: Lens,
    label: "Oracle",
    path: "/oracle",
    prefetch: (queryClient) => [
      queryClient.query(oracleQueries.state()),
      queryClient.query(oracleQueries.events("fast_mint")),
      queryClient.query(oracleQueries.executions()),
      queryClient.query(hubQueries.tokens()),
    ],
  },
  {
    icon: Blocks,
    label: "Allocator",
    path: "/allocator",
    prefetch: (queryClient) => [
      queryClient.query(allocatorQueries.state()),
      queryClient.query(allocatorQueries.events("payload_built")),
    ],
  },
  {
    icon: Cpu,
    label: "Executor",
    path: "/executor",
    prefetch: (queryClient) => [
      queryClient.query(executorQueries.state()),
      queryClient.query(executorQueries.events("executor_executed")),
      queryClient.query(hubQueries.tokens()),
    ],
  },
  {
    icon: ChartPie,
    label: "Pools",
    path: "/pools",
    prefetch: (queryClient) => [
      queryClient.query(poolQueries.list()).then((data) => {
        const address = storedPool(toPools(data))?.address
        if (!address) return
        const pool = xerc20Queries(address)
        return Promise.allSettled([
          queryClient.query(pool.lockboxes()),
          queryClient.query(pool.state()),
          queryClient.query(pool.events(LOCKBOX_EVENT_KINDS.join(","))),
          queryClient.query(pool.events(ADMIN_EVENT_KINDS.join(","))),
        ])
      }),
    ],
  },
  {
    icon: CircleDollarSign,
    label: "Prices",
    path: "/prices",
    prefetch: (queryClient) => [
      queryClient.query(priceQueries.sources()),
      queryClient.query(priceQueries.all()),
      queryClient.query(priceOracleQueries.feeds()),
    ],
  },
  {
    icon: BellRing,
    label: "Alerts",
    path: "/alerts",
    prefetch: (queryClient) => [
      queryClient.query(hubQueries.deficits()),
      queryClient.query(hubQueries.tokens()),
      queryClient.query(hubQueries.state()),
      queryClient.query(oracleQueries.state()),
      queryClient.query(allocatorQueries.state()),
      queryClient.query(executorQueries.state()),
    ],
  },
]
