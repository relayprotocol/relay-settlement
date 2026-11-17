import { useQuery } from "@tanstack/react-query"
import { poolQueries } from "./api/queries"
import type { Chain, ListPoolsResponse, PoolType } from "./api/schema"
import { readStorage } from "./storage"
import { shortAddress } from "./utils"

export type Pool = {
  address: string
  chain: Chain
  name: string
  type: PoolType
}

export const POOL_TYPES: Record<PoolType, string> = { xerc20: "xERC20" }

export const toPools = ({ chain, pools }: ListPoolsResponse): Pool[] =>
  pools.map((pool) => ({
    address: pool.address.toLowerCase(),
    chain,
    name: pool.name ?? pool.symbol ?? shortAddress(pool.address),
    type: pool.type,
  }))

export const usePools = () =>
  useQuery({ ...poolQueries.list(), select: toPools })

export const poolPath = (address: string) => `/pools/${address}`

export const STORED_POOL = "pools:pool"

export const storedPool = (pools: Pool[]) => {
  const stored = readStorage(STORED_POOL)
  return pools.find((pool) => pool.address === stored) ?? pools[0]
}

export const LOCKBOX_EVENT_KINDS = [
  "xerc20_lockbox_deposit",
  "xerc20_lockbox_withdraw",
]

export const ADMIN_EVENT_KINDS = [
  "xerc20_bridge_limits_set",
  "xerc20_lockbox_set",
  "ownership_transferred",
]
