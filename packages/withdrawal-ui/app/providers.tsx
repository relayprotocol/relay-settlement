"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider, createConfig, http } from "wagmi"
import {
  mainnet,
  sepolia,
  aurora,
  arbitrumSepolia,
  base,
  arbitrum,
  optimism,
  polygon,
  hardhat,
} from "wagmi/chains"
import { ReactNode, useState } from "react"

const config = createConfig({
  chains: [
    mainnet,
    sepolia,
    aurora,
    arbitrumSepolia,
    base,
    arbitrum,
    optimism,
    polygon,
    hardhat,
  ],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
    [aurora.id]: http(),
    [arbitrumSepolia.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [hardhat.id]: http("http://127.0.0.1:8545"),
  },
})

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
