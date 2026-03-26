"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider, createConfig, http } from "wagmi"
import { type Chain } from "viem"
import { ReactNode, useEffect, useState } from "react"
import { getChains, type ChainInfo } from "@/lib/core/withdrawal/chains"

function solverChainToViemChain(chain: ChainInfo): Chain {
  return {
    id: chain.id,
    name: chain.displayName,
    nativeCurrency: {
      name: chain.currency.name,
      symbol: chain.currency.symbol,
      decimals: chain.currency.decimals,
    },
    rpcUrls: {
      default: { http: [chain.httpRpcUrl] },
    },
    blockExplorers: chain.explorerUrl
      ? {
          default: {
            name: "Explorer",
            url: chain.explorerUrl,
          },
        }
      : undefined,
  }
}

function buildWagmiConfig(solverChains: ChainInfo[]) {
  if (solverChains.length === 0) {
    throw new Error("No chains returned from solver API")
  }
  const chains = solverChains.map(solverChainToViemChain) as [Chain, ...Chain[]]
  const transports: Record<number, ReturnType<typeof http>> = {}
  for (const chain of solverChains) {
    transports[chain.id] = http(chain.httpRpcUrl)
  }
  return createConfig({ chains, transports })
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const [wagmiConfig, setWagmiConfig] = useState<ReturnType<
    typeof createConfig
  > | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadChains = () => {
    setError(null)
    getChains()
      .then((chains) => setWagmiConfig(buildWagmiConfig(chains)))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load chains")
      )
  }

  useEffect(() => {
    loadChains()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-3">
          <p className="text-sm text-error">{error}</p>
          <button className="btn-secondary btn-sm" onClick={loadChains}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!wagmiConfig) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex items-center gap-3">
          <div className="spinner" />
          <span className="text-subtle text-sm">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
