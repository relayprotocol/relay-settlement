"use client"

import { useState, useEffect } from "react"
import { useAccount } from "wagmi"
import { formatUnits } from "viem"
import {
  getChains,
  getChainCurrencies,
  type ChainInfo,
  type ChainCurrency,
} from "@/lib/core/withdrawal/chains"
import { getHubBalance } from "@/lib/core/withdrawal/balance"
import { attestDeposit } from "@/lib/core/withdrawal/api"
import {
  getPendingJobs,
  getAllJobs,
  type StoredJob,
} from "@/lib/core/withdrawal/session"
import { HUB_CHAIN, hubClient } from "@/lib/config"
import { type WithdrawalConfig } from "@/lib/core/withdrawal/types"
import { WithdrawalFlow } from "./WithdrawalFlow"
import { CopyableAddress } from "./CopyableAddress"
import { ChainIcon, TokenIcon } from "./ChainTokenIcon"
import { Dropdown } from "./Dropdown"

export function WithdrawalPage() {
  const { address } = useAccount()

  const [chains, setChains] = useState<ChainInfo[]>([])
  const [selectedChain, setSelectedChain] = useState<ChainInfo | null>(null)
  const [currencies, setCurrencies] = useState<ChainCurrency[]>([])
  const [selectedCurrency, setSelectedCurrency] =
    useState<ChainCurrency | null>(null)
  const [hubBalance, setHubBalance] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(true)

  // Committed selection — only set when user clicks "Continue"
  const [committed, setCommitted] = useState<WithdrawalConfig | null>(null)
  // Resume a pending job
  const [resumeJobId, setResumeJobId] = useState<string | null>(null)

  const [transactionId, setTransactionId] = useState("")
  const [attesting, setAttesting] = useState(false)
  const [attestError, setAttestError] = useState<string | null>(null)
  const [attestSuccess, setAttestSuccess] = useState(false)

  const [allJobs, setAllJobs] = useState<StoredJob[]>([])

  useEffect(() => {
    setAllJobs(getAllJobs())
  }, [])

  // Fetch chains on mount
  useEffect(() => {
    getChains()
      .then((c) => {
        setChains(c)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Fetch currencies when chain changes
  useEffect(() => {
    if (!selectedChain) {
      setCurrencies([])
      setSelectedCurrency(null)
      return
    }
    getChainCurrencies(selectedChain.id).then((c) => {
      setCurrencies(c)
      setSelectedCurrency(null)
    })
  }, [selectedChain])

  // Fetch hub balance when selection changes, then poll every 10s
  useEffect(() => {
    if (!selectedChain || !selectedCurrency || !address) {
      setHubBalance(null)
      return
    }
    setHubBalance(null)
    const fetchBalance = () => {
      getHubBalance(hubClient, HUB_CHAIN.relayHubAddress, {
        chainSlug: selectedChain.name,
        currency: selectedCurrency.address,
        owner: address,
        ownerChainSlug: selectedChain.name,
        vmType: selectedChain.vmType,
      })
        .then(setHubBalance)
        .catch(() => setHubBalance(null))
    }
    fetchBalance()
    const interval = setInterval(fetchBalance, 10_000)
    return () => clearInterval(interval)
  }, [selectedChain, selectedCurrency, address])

  const refreshBalance = () => {
    if (!selectedChain || !selectedCurrency || !address) return
    setHubBalance(null)
    getHubBalance(hubClient, HUB_CHAIN.relayHubAddress, {
      chainSlug: selectedChain.name,
      currency: selectedCurrency.address,
      owner: address,
      ownerChainSlug: selectedChain.name,
      vmType: selectedChain.vmType,
    })
      .then(setHubBalance)
      .catch(() => setHubBalance(null))
  }

  const handleAttestDeposit = async () => {
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
      refreshBalance()
    } catch (err) {
      setAttestError(
        err instanceof Error ? err.message : "Attest deposit failed"
      )
    } finally {
      setAttesting(false)
    }
  }

  const handleContinue = () => {
    if (!selectedChain || !selectedCurrency) return
    setCommitted({
      chainId: String(selectedChain.id),
      chainSlug: selectedChain.name,
      currency: selectedCurrency.address,
      decimals: selectedCurrency.decimals,
      ownerChainId: String(selectedChain.id),
      ownerChainSlug: selectedChain.name,
      vmType: selectedChain.vmType,
    })
  }

  const handleBack = () => {
    setCommitted(null)
    setResumeJobId(null)
    setAllJobs(getAllJobs())
  }

  const handleResume = (jobId: string, params: any) => {
    setCommitted({
      chainId: params.chainId,
      chainSlug: params.chainSlug,
      currency: params.currency,
      decimals: params.decimals ?? 18,
      ownerChainId: params.ownerChainId,
      ownerChainSlug: params.ownerChainSlug,
      vmType: params.vmType ?? "evm",
    })
    setResumeJobId(jobId)
  }

  // Show WithdrawalFlow once chain/currency committed
  if (committed) {
    return (
      <div className="max-w-lg mx-auto space-y-4">
        <button onClick={handleBack} className="btn-ghost text-sm">
          &larr; Back
        </button>
        <WithdrawalFlow {...committed} resumeJobId={resumeJobId} />
      </div>
    )
  }

  // Selection UI
  return (
    <div className="max-w-lg mx-auto space-y-4">
      {/* Withdrawal history */}
      {allJobs.length > 0 && (
        <div className="card space-y-3">
          <h3 className="font-heading font-bold text-lg">Withdrawals</h3>
          {allJobs.map((job) => {
            const isPending =
              job.status === "processing" || job.status === "ready"
            const statusBadge = {
              processing: { class: "badge-info", label: "Processing" },
              ready: { class: "badge-warning", label: "Ready" },
              executed: { class: "badge-success", label: "Executed" },
              expired: { class: "badge-error", label: "Expired" },
              failed: { class: "badge-error", label: "Failed" },
            }[job.status] ?? { class: "badge-info", label: job.status }

            const rawAmount = job.validatedAmount ?? job.params.amount
            const decimals = job.params.decimals ?? 18
            let displayAmount: string
            try {
              displayAmount = formatUnits(BigInt(rawAmount), decimals)
            } catch {
              displayAmount = rawAmount
            }

            return (
              <button
                key={job.jobId}
                className="p-3 bg-gray-50 rounded-xl flex items-center justify-between w-full text-left hover:bg-gray-100 transition-colors cursor-pointer"
                onClick={() => handleResume(job.jobId, job.params)}
              >
                <div className="min-w-0 flex items-center gap-3">
                  <ChainIcon chainId={Number(job.params.chainId)} size={24} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {displayAmount}
                      </span>
                      <span className="text-xs text-subtle">
                        on {job.params.chainSlug}
                      </span>
                      <span className={`badge ${statusBadge.class}`}>
                        {statusBadge.label}
                      </span>
                    </div>
                    <div className="text-xs text-subtle">
                      {new Date(job.createdAt).toLocaleString()}
                      {job.txHash && (
                        <span className="ml-2 font-mono">
                          Tx: {job.txHash.slice(0, 10)}...
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <span className="text-gray-400 flex-shrink-0 ml-2">
                  &#8250;
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="card space-y-4">
        <h3 className="font-heading font-bold text-lg">Withdraw</h3>

        {loading ? (
          <div className="flex items-center gap-3 py-4">
            <div className="spinner" />
            <span className="text-subtle text-sm">Loading chains...</span>
          </div>
        ) : (
          <>
            {/* Chain selector */}
            <div>
              <label className="text-sm text-subtle block mb-1">Chain</label>
              <Dropdown
                trigger={
                  <button className="input w-full flex items-center gap-2 text-left">
                    {selectedChain ? (
                      <>
                        <ChainIcon chainId={selectedChain.id} size={20} />
                        <span>{selectedChain.displayName}</span>
                      </>
                    ) : (
                      <span className="text-gray-400">Select chain</span>
                    )}
                    <span className="ml-auto text-gray-400">&#9662;</span>
                  </button>
                }
                items={chains.map((chain) => ({
                  key: String(chain.id),
                  icon: <ChainIcon chainId={chain.id} size={20} />,
                  label: chain.displayName,
                  onClick: () => setSelectedChain(chain),
                }))}
              />
            </div>

            {/* Currency selector */}
            {selectedChain && (
              <div>
                <label className="text-sm text-subtle block mb-1">Token</label>
                <Dropdown
                  trigger={
                    <button className="input w-full flex items-center gap-2 text-left">
                      {selectedCurrency ? (
                        <>
                          <TokenIcon
                            logoURI={selectedCurrency.logoURI}
                            symbol={selectedCurrency.symbol}
                            size={20}
                          />
                          <span>{selectedCurrency.symbol}</span>
                          <span className="text-subtle text-sm">
                            {selectedCurrency.name}
                          </span>
                        </>
                      ) : (
                        <span className="text-gray-400">Select token</span>
                      )}
                      <span className="ml-auto text-gray-400">&#9662;</span>
                    </button>
                  }
                  items={currencies.map((curr) => ({
                    key: curr.address,
                    icon: (
                      <TokenIcon
                        logoURI={curr.logoURI}
                        symbol={curr.symbol}
                        size={20}
                      />
                    ),
                    label: curr.symbol,
                    sublabel: curr.name,
                    onClick: () => setSelectedCurrency(curr),
                  }))}
                />
              </div>
            )}

            {/* Balance preview */}
            {selectedCurrency && (
              <div className="p-3 bg-gray-50 rounded-xl">
                <span className="text-sm text-subtle">Hub Balance: </span>
                {hubBalance !== null ? (
                  hubBalance > 0n ? (
                    <span className="text-sm font-mono font-medium text-default">
                      {formatUnits(hubBalance, selectedCurrency.decimals)}{" "}
                      {selectedCurrency.symbol}
                    </span>
                  ) : (
                    <span className="text-sm text-error">No balance</span>
                  )
                ) : (
                  <span className="text-sm text-subtle">Loading...</span>
                )}
              </div>
            )}

            {/* Transaction ID (optional — attest a deposit) */}
            {selectedCurrency && (
              <div>
                <label className="text-sm text-subtle block mb-1">
                  Transaction ID{" "}
                  <span className="text-xs text-gray-400">(optional)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="input font-mono flex-1"
                    placeholder="0x..."
                    value={transactionId}
                    onChange={(e) => {
                      setTransactionId(e.target.value)
                      setAttestError(null)
                      setAttestSuccess(false)
                    }}
                  />
                  <button
                    className="btn-secondary flex-shrink-0"
                    disabled={
                      !transactionId.trim() || attesting || !selectedChain
                    }
                    onClick={handleAttestDeposit}
                  >
                    {attesting ? (
                      <>
                        <div className="spinner !w-4 !h-4" />
                        Attesting...
                      </>
                    ) : (
                      "Attest Deposit"
                    )}
                  </button>
                </div>
                {attestError && (
                  <p className="text-xs text-error mt-1">{attestError}</p>
                )}
                {attestSuccess && (
                  <p className="text-xs text-green-600 mt-1">
                    Deposit attested successfully
                  </p>
                )}
              </div>
            )}

            {/* Continue */}
            <button
              className="btn-primary w-full"
              disabled={
                !selectedChain ||
                !selectedCurrency ||
                hubBalance === null ||
                hubBalance === 0n
              }
              onClick={handleContinue}
            >
              {hubBalance === 0n ? "No balance to withdraw" : "Continue"}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
