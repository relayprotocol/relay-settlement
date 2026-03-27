"use client"

import { useState } from "react"
import { type ChainInfo } from "@/lib/core/withdrawal/chains"
import { attestDeposit } from "@/lib/core/withdrawal/api"
import { useChains } from "@/lib/react/useChains"
import { ChainSelector, ChainsLoadingState } from "./ChainSelector"

export function DepositPage() {
  const {
    chains,
    loading: chainsLoading,
    error: chainsError,
    retry: retryChains,
  } = useChains()

  const [selectedChain, setSelectedChain] = useState<ChainInfo | null>(null)

  const [transactionId, setTransactionId] = useState("")
  const [attesting, setAttesting] = useState(false)
  const [attestError, setAttestError] = useState<string | null>(null)
  const [attestSuccess, setAttestSuccess] = useState(false)

  const handleAttest = async () => {
    if (!selectedChain || !transactionId.trim()) return
    setAttesting(true)
    setAttestError(null)
    setAttestSuccess(false)
    try {
      await attestDeposit({
        chainId: selectedChain.id,
        transactionId: transactionId.trim(),
      })
      setAttestSuccess(true)
      setTransactionId("")
    } catch (err) {
      setAttestError(
        err instanceof Error ? err.message : "Attest deposit failed"
      )
    } finally {
      setAttesting(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <div className="card space-y-4">
        <h3 className="font-heading font-bold text-lg">Attest Deposit</h3>
        <p className="text-sm text-subtle">
          Submit a deposit transaction for attestation so your Hub balance
          updates faster.
        </p>

        {chainsLoading || chainsError ? (
          <ChainsLoadingState
            loading={chainsLoading}
            error={chainsError}
            retry={retryChains}
          />
        ) : (
          <>
            {/* Chain selector */}
            <ChainSelector
              chains={chains}
              selected={selectedChain}
              onSelect={(chain) => {
                setSelectedChain(chain)
                setAttestError(null)
                setAttestSuccess(false)
              }}
              label="Deposit Chain"
            />

            {/* Transaction ID */}
            {selectedChain && (
              <div>
                <label className="text-sm text-subtle block mb-1">
                  Transaction Hash
                </label>
                <input
                  type="text"
                  className="input font-mono w-full"
                  placeholder="0x..."
                  value={transactionId}
                  onChange={(e) => {
                    setTransactionId(e.target.value)
                    setAttestError(null)
                    setAttestSuccess(false)
                  }}
                />
              </div>
            )}

            {/* Attest button */}
            {selectedChain && (
              <button
                className="btn-primary w-full"
                disabled={!transactionId.trim() || attesting}
                onClick={handleAttest}
              >
                {attesting ? (
                  <>
                    <div className="spinner !w-4 !h-4 !border-white/30 !border-t-white" />
                    Attesting...
                  </>
                ) : (
                  "Attest Deposit"
                )}
              </button>
            )}

            {/* Feedback */}
            {attestError && (
              <div className="p-3 rounded-xl border border-red-200 bg-red-50">
                <p className="text-sm text-error">{attestError}</p>
              </div>
            )}
            {attestSuccess && (
              <div className="p-3 rounded-xl border border-green-200 bg-green-50">
                <p className="text-sm text-green-700">
                  Deposit attested successfully. Your Hub balance will update
                  shortly.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
