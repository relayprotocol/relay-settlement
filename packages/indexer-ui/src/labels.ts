import { useQuery } from "@tanstack/react-query"
import { indexerQueries, poolQueries } from "./api/queries"
import type { ChainConfigView, ProtocolConfigView } from "./api/schema"
import { chainPath } from "./origins"
import { formatChainName, RELAY_SOLVER_ADDRESS, shortHash } from "./utils"

const CONTRACT_NAMES: Partial<Record<keyof ProtocolConfigView, string>> = {
  allocator: "RelayAllocator",
  executor: "RelayExecutor",
  fee_calculators: "RelayBpsFeeCalculator",
  hub: "RelayHub",
  hubs: "RelayHub",
  idempotency_store: "RelayOracleIdempotencyStore",
  multicall3: "Multicall3",
  oracle: "RelayOracle",
  oracle_multisig: "RelayOracleMultisig",
  oracles: "RelayOracle",
  price_oracle: "RelayPriceOracle",
  price_oracles: "RelayPriceOracle",
  rate_limiters: "RelayUsdRateLimiter",
  withdraw_gas_payer: "WithdrawGasPayer",
}

const PROVIDER_NAMES: Record<string, string> = {
  "0x477a6446c896dd7534f801b64251153885069a0bb95a959ddbdb23b8e23c18d1": "Stork",
}

export const providerName = (id: string) =>
  PROVIDER_NAMES[id.toLowerCase()] ?? shortHash(id)

const fallbackChainName = (chain: string) =>
  formatChainName(chain.replaceAll(/[_-]/g, " "))

export const useLabels = () => {
  const config = useQuery(indexerQueries.config()).data
  const pools = useQuery(poolQueries.list()).data?.pools
  const protocol = config?.protocol
  const addresses = new Map([
    [RELAY_SOLVER_ADDRESS, "Relay Solver"],
    ...(pools ?? []).flatMap(({ address, name, symbol }) => {
      const label = name ?? symbol
      return label ? [[address.toLowerCase(), label] as const] : []
    }),
    ...Object.entries(CONTRACT_NAMES).flatMap(([key, name]) =>
      [protocol?.[key as keyof ProtocolConfigView] ?? []]
        .flat()
        .flatMap((address) =>
          typeof address === "string"
            ? [[address.toLowerCase(), name] as const]
            : []
        )
    ),
  ])
  const chains = new Map<string, ChainConfigView>(
    config?.chains.map((chain) => [chain.chain, chain])
  )
  const origins = new Map(
    config?.chains.flatMap((chain) =>
      [
        chain.hub_chain_id,
        chain.gateway_hub_chain_id,
        ...chain.origin_chain_ids,
      ].flatMap((id) => (id ? [[id, chain] as const] : []))
    )
  )
  return {
    address: (address: string) => addresses.get(address.toLowerCase()),
    chain: (chain: string) => {
      const name = chains.get(chain)?.name
      return name ? formatChainName(name) : fallbackChainName(chain)
    },
    networkId: (chain: string) => chains.get(chain)?.network_id,
    chainPath: (chain: string, gateway = false) => {
      const config = chains.get(chain)
      if (!config?.depositories.length) return undefined
      return chainPath(chain, gateway && !!config.gateway_depository)
    },
    gateway: (chain: string, depository?: string | null) =>
      !!depository &&
      chains.get(chain)?.gateway_depository?.toLowerCase() ===
        depository.toLowerCase(),
    origin: (id?: string | null) => (id ? origins.get(id) : undefined),
    originChain: (id?: string | null) => {
      const chain = id ? origins.get(id) : undefined
      return chain ? formatChainName(chain.name) : (id ?? "-")
    },
    originNetworkId: (id?: string | null) =>
      id ? (origins.get(id)?.network_id ?? id) : undefined,
  }
}
