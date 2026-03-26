"use client"

import { useEffect, useState } from "react"
import { useAccount, useConnect, useDisconnect } from "wagmi"
import { WithdrawalPage } from "@/components/WithdrawalPage"
import { RelayLogo, RelayIcon } from "@/components/RelayLogo"

export default function Home() {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const [mounted, setMounted] = useState(false)

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
          <div className="flex items-center gap-3">
            <RelayIcon size={28} />
            <span className="font-heading font-bold text-xl text-default">
              Withdraw
            </span>
          </div>
          {connected ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-subtle font-mono">
                {address?.slice(0, 6)}...{address?.slice(-4)}
              </span>
              <button onClick={() => disconnect()} className="btn-white btn-sm">
                Disconnect
              </button>
            </div>
          ) : mounted ? (
            <div className="flex items-center gap-2">
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  onClick={() => connect({ connector })}
                  className="btn-primary btn-sm"
                >
                  {connector.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {connected ? (
          <WithdrawalPage />
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
