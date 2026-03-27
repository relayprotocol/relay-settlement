"use client"

import { createContext, useContext, useState, type ReactNode } from "react"

type WalletChainFilter = "EVM" | "SOL" | "BTC" | "SUI" | "TRON" | undefined

interface WalletFilterState {
  walletFilter: WalletChainFilter
  setWalletFilter: (value: WalletChainFilter) => void
}

const WalletFilterContext = createContext<WalletFilterState | undefined>(
  undefined
)

export function WalletFilterProvider({ children }: { children: ReactNode }) {
  const [walletFilter, setWalletFilter] = useState<WalletChainFilter>(undefined)

  return (
    <WalletFilterContext.Provider value={{ walletFilter, setWalletFilter }}>
      {children}
    </WalletFilterContext.Provider>
  )
}

export function useWalletFilter() {
  const context = useContext(WalletFilterContext)
  if (!context) {
    throw new Error("useWalletFilter must be used within WalletFilterProvider")
  }
  return context
}
