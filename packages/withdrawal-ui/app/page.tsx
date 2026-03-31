"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { DynamicWidget } from "@dynamic-labs/sdk-react-core"
import { WithdrawalPage } from "@/components/WithdrawalPage"
import { DepositPage } from "@/components/DepositPage"
import { RelayLogo } from "@/components/RelayLogo"

type Tab = "withdraw" | "deposit"

export default function Home() {
  const { isConnected } = useAccount()
  const [mounted, setMounted] = useState(false)
  const [tab, setTab] = useState<Tab>("deposit")

  useEffect(() => {
    setMounted(true)
  }, [])

  const connected = mounted && isConnected

  return (
    <main className="min-h-screen">
      {/* Header */}
      <header
        className="bg-white"
        style={{ boxShadow: "0px 1px 3px rgba(0, 0, 0, 0.04)" }}
      >
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
          <RelayLogo height={28} className="text-[#0D0C0D]" />
          <DynamicWidget />
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {connected ? (
          <>
            {/* Tabs */}
            <div className="max-w-lg mx-auto mb-6">
              <div className="flex gap-1 p-1 bg-gray-100 rounded-xl">
                <button
                  className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
                    tab === "deposit"
                      ? "bg-white text-default shadow-sm"
                      : "text-subtle hover:text-default"
                  }`}
                  onClick={() => setTab("deposit")}
                >
                  Attest
                </button>
                <button
                  className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
                    tab === "withdraw"
                      ? "bg-white text-default shadow-sm"
                      : "text-subtle hover:text-default"
                  }`}
                  onClick={() => setTab("withdraw")}
                >
                  Withdraw
                </button>
              </div>
            </div>

            {tab === "withdraw" ? <WithdrawalPage /> : <DepositPage />}
          </>
        ) : (
          <div className="text-center py-16">
            <div className="mb-6">
              <RelayLogo height={36} className="mx-auto text-default" />
            </div>
            <p className="text-subtle">Connect your wallet to continue</p>
          </div>
        )}
      </div>
    </main>
  )
}
