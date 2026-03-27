"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider, createConfig, http } from "wagmi"
import { type Chain } from "viem"
import { ReactNode, useEffect, useState } from "react"
import {
  FilterChain,
  DynamicContextProvider,
} from "@dynamic-labs/sdk-react-core"
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum"
import { SolanaWalletConnectors } from "@dynamic-labs/solana"
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector"
import { getChains, type ChainInfo } from "@/lib/core/withdrawal/chains"
import {
  WalletFilterProvider,
  useWalletFilter,
} from "@/lib/react/useWalletFilter"

const DYNAMIC_ENV_ID = process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID ?? ""

function chainToDynamicNetwork(chain: ChainInfo) {
  return {
    blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : [],
    chainId: chain.id,
    chainName: chain.name,
    iconUrls: chain.iconUrl ? [chain.iconUrl] : [],
    name: chain.displayName,
    nativeCurrency: {
      decimals: chain.currency.decimals,
      name: chain.currency.name,
      symbol: chain.currency.symbol,
    },
    networkId: chain.id,
    rpcUrls: chain.httpRpcUrl ? [chain.httpRpcUrl] : [],
    vanityName: chain.displayName,
  }
}

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
  return createConfig({
    chains,
    multiInjectedProviderDiscovery: false,
    transports,
  })
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletFilterProvider>
      <ProvidersInner>{children}</ProvidersInner>
    </WalletFilterProvider>
  )
}

function ProvidersInner({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const [wagmiConfig, setWagmiConfig] = useState<ReturnType<
    typeof createConfig
  > | null>(null)
  const [solverChains, setSolverChains] = useState<ChainInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const { walletFilter, setWalletFilter } = useWalletFilter()

  const loadChains = () => {
    setError(null)
    getChains()
      .then((chains) => {
        setSolverChains(chains)
        setWagmiConfig(buildWagmiConfig(chains))
      })
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
    <DynamicContextProvider
      settings={{
        environmentId: DYNAMIC_ENV_ID,
        walletConnectors: [EthereumWalletConnectors, SolanaWalletConnectors],
        initialAuthenticationMode: "connect-only",
        appName: "Relay Withdraw",
        overrides: {
          evmNetworks: () =>
            solverChains
              .filter((c) => c.vmType === "evm")
              .map(chainToDynamicNetwork),
        },
        walletsFilter: walletFilter ? FilterChain(walletFilter) : undefined,
        events: {
          onAuthFlowClose: () => {
            setWalletFilter(undefined)
          },
        },
        cssOverrides: `
          .connect-button { font-size: 14px; }
          [data-testid="send-balance-button"] { display: none; }
        `,
      }}
      locale={{
        en: {
          dyn_login: {
            title: {
              all: "Connect Wallet",
            },
          },
          dyn_widget: {
            connect: "Connect Wallet",
          },
        },
      }}
    >
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  )
}
