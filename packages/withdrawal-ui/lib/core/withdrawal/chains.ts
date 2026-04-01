import { SOLVER_API_URL } from "@/lib/config"

export interface ChainCurrency {
  id: string
  symbol: string
  name: string
  address: string
  decimals: number
  logoURI?: string
}

export interface ChainInfo {
  id: number
  name: string
  displayName: string
  vmType: string
  explorerUrl: string
  iconUrl: string | null
  httpRpcUrl: string
  currency: ChainCurrency
  erc20Currencies: ChainCurrency[]
}

/**
 * Currency logo URL — relay CDN, same as relay-kit.
 * Falls back to solver's metadata.logoURI if available.
 */
function getCurrencyLogoURI(currency: any): string | undefined {
  // featuredTokens have metadata.logoURI
  if (
    currency.metadata?.logoURI &&
    currency.metadata.logoURI !== "missing.png"
  ) {
    return currency.metadata.logoURI
  }
  // Fallback: relay CDN by currency ID
  if (currency.id) {
    return `https://assets.relay.link/icons/currencies/${currency.id}.png`
  }
  return undefined
}

let chainsCache: ChainInfo[] | null = null

/** Parse NEXT_PUBLIC_RPC env var: JSON map of chainId → rpcUrl */
function getRpcOverrides(): Record<string, string> {
  try {
    return JSON.parse(process.env.NEXT_PUBLIC_RPC ?? "{}")
  } catch {
    return {}
  }
}

/** Fetch supported chains and currencies from solver API */
export async function getChains(): Promise<ChainInfo[]> {
  if (chainsCache) return chainsCache

  const res = await fetch(`${SOLVER_API_URL}/chains`)
  if (!res.ok) {
    throw new Error(`Failed to fetch chains (${res.status})`)
  }
  const data = await res.json()

  // Normalize currencies to include logoURI
  const rpcOverrides = getRpcOverrides()
  chainsCache = (data.chains as any[]).map((chain) => ({
    ...chain,
    httpRpcUrl: rpcOverrides[String(chain.id)] ?? chain.httpRpcUrl,
    currency: {
      ...chain.currency,
      logoURI: getCurrencyLogoURI(chain.currency),
    },
    erc20Currencies: (chain.erc20Currencies ?? []).map((c: any) => ({
      ...c,
      logoURI: getCurrencyLogoURI(c),
    })),
  })) as ChainInfo[]

  return chainsCache
}

/** Find a specific chain by ID */
export async function getChain(
  chainId: number
): Promise<ChainInfo | undefined> {
  const chains = await getChains()
  return chains.find((c) => c.id === chainId)
}

/** Get all currencies for a chain (native + ERC20) */
export async function getChainCurrencies(
  chainId: number
): Promise<ChainCurrency[]> {
  const chain = await getChain(chainId)
  if (!chain) return []
  return [chain.currency, ...chain.erc20Currencies]
}

/** Find a currency by chain ID and address */
export async function findCurrency(
  chainId: number,
  address: string
): Promise<ChainCurrency | undefined> {
  const currencies = await getChainCurrencies(chainId)
  return currencies.find(
    (c) => c.address.toLowerCase() === address.toLowerCase()
  )
}
