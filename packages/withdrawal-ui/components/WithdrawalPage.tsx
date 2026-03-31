"use client"

import { useState, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { useAccount } from "wagmi"
import { useUserWallets } from "@dynamic-labs/sdk-react-core"
import { useDynamicModals } from "@dynamic-labs/sdk-react-core"
import {
  createPublicClient,
  http,
  formatUnits,
  erc20Abi,
  isAddress,
} from "viem"
import {
  getChainCurrencies,
  type ChainInfo,
  type ChainCurrency,
} from "@/lib/core/withdrawal/chains"
import { useChains } from "@/lib/react/useChains"
import { ChainSelector, ChainsLoadingState } from "./ChainSelector"
import {
  VM_CONFIG,
  getVmDisplayName,
  isWithdrawalVmSupported,
  toDynamicChain,
} from "@/lib/core/withdrawal/vmTypes"
import { getHubBalance, getHubBalances } from "@/lib/core/withdrawal/balance"
import { getAllJobs, type StoredJob } from "@/lib/core/withdrawal/session"
import { HUB_CHAIN, hubClient } from "@/lib/config"
import { type WithdrawalConfig } from "@/lib/core/withdrawal/types"
import { WithdrawalFlow } from "./WithdrawalFlow"
import { ChainIcon, TokenIcon } from "./ChainTokenIcon"
import { Dropdown } from "./Dropdown"
import { useWalletFilter } from "@/lib/react/useWalletFilter"

/** Query ERC20 decimals + symbol from chain RPC */
async function lookupToken(
  rpcUrl: string,
  address: string
): Promise<{ symbol: string; decimals: number }> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  const [symbol, decimals] = await Promise.all([
    client.readContract({
      address: address as `0x${string}`,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    client.readContract({
      address: address as `0x${string}`,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ])
  return { symbol: symbol as string, decimals: Number(decimals) }
}

export function WithdrawalPage() {
  const { address } = useAccount()
  const searchParams = useSearchParams()
  const overrideWallet = searchParams.get("overrideWallet")
  const { setShowLinkNewWalletModal } = useDynamicModals()
  const { setWalletFilter } = useWalletFilter()

  const {
    chains,
    loading: chainsLoading,
    error: chainsError,
    retry: retryChains,
  } = useChains()
  const supportedChains = chains.filter((chain) =>
    isWithdrawalVmSupported(chain.vmType)
  )

  const [selectedChain, setSelectedChain] = useState<ChainInfo | null>(null)
  const [currencies, setCurrencies] = useState<ChainCurrency[]>([])
  const [selectedCurrency, setSelectedCurrency] =
    useState<ChainCurrency | null>(null)
  const [hubBalance, setHubBalance] = useState<bigint | null>(null)
  const [useCustomCurrency, setUseCustomCurrency] = useState(false)
  const [customAddress, setCustomAddress] = useState("")
  const [customLoading, setCustomLoading] = useState(false)
  const [customLookupFailed, setCustomLookupFailed] = useState(false)
  const [currencyBalances, setCurrencyBalances] = useState<
    Record<string, bigint>
  >({})

  // Committed selection — only set when user clicks "Continue"
  const [committed, setCommitted] = useState<WithdrawalConfig | null>(null)
  // Counter to force WithdrawalFlow remount on each new flow
  const [flowKey, setFlowKey] = useState(0)
  // Resume a pending job
  const [resumeJobId, setResumeJobId] = useState<string | null>(null)

  const [allJobs, setAllJobs] = useState<StoredJob[]>([])
  const [showAllHistory, setShowAllHistory] = useState(false)
  const visibleJobs = allJobs.filter((job) =>
    isWithdrawalVmSupported(job.params.vmType ?? "evm")
  )

  useEffect(() => {
    setAllJobs(getAllJobs())
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
    setUseCustomCurrency(false)
    setCustomAddress("")
    setCustomLookupFailed(false)
  }, [selectedChain])

  // Detect connected wallet VM types from Dynamic
  const userWallets = useUserWallets()

  const connectedVmTypes = new Set<string>()
  for (const w of userWallets) {
    const chain = w.chain
    // Dynamic may report EVM wallets as "EVM" or "ETH"
    if (chain === "ETH") {
      connectedVmTypes.add("evm")
      continue
    }
    const vmType = Object.entries(VM_CONFIG).find(
      ([, cfg]) => cfg.dynamicChain === chain
    )?.[0]
    if (vmType) connectedVmTypes.add(vmType)
  }
  if (address) connectedVmTypes.add("evm")
  // hypevm uses same Dynamic chain as evm — must run after evm is resolved
  if (connectedVmTypes.has("evm")) connectedVmTypes.add("hypevm")

  const isWalletCompatible = selectedChain
    ? connectedVmTypes.has(selectedChain.vmType)
    : false

  // Get the wallet address for a specific VM type
  const getOwnerAddress = (vmType: string): string | null => {
    if (vmType === "evm" || vmType === "hypevm") return address ?? null
    const dynamicChain = toDynamicChain(vmType)
    if (!dynamicChain) return null
    const wallet = userWallets.find((w) => w.chain === dynamicChain)
    return wallet?.address ?? null
  }

  const ownerAddress = overrideWallet
    ? overrideWallet
    : selectedChain
      ? getOwnerAddress(selectedChain.vmType)
      : null

  // Preload hub balances when currencies + owner are available
  // Batches in chunks of 20 to avoid oversized multicalls
  // Polls every 5 seconds to keep balances up to date
  useEffect(() => {
    setCurrencyBalances({})
    if (!selectedChain || !ownerAddress || currencies.length === 0) return

    const BATCH_SIZE = 20
    const batches: string[][] = []
    for (let i = 0; i < currencies.length; i += BATCH_SIZE) {
      batches.push(currencies.slice(i, i + BATCH_SIZE).map((c) => c.address))
    }

    let cancelled = false
    const fetchAllBalances = async () => {
      for (const batch of batches) {
        if (cancelled) return
        try {
          const result = await getHubBalances(
            hubClient,
            HUB_CHAIN.relayHubAddress,
            {
              chainSlug: selectedChain.name,
              currencies: batch,
              owner: ownerAddress,
              ownerChainSlug: selectedChain.name,
              vmType: selectedChain.vmType,
            }
          )
          if (!cancelled) {
            setCurrencyBalances((prev) => ({ ...prev, ...result }))
          }
        } catch {
          // continue with next batch
        }
      }
    }
    fetchAllBalances()
    const interval = setInterval(fetchAllBalances, 5_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [selectedChain, ownerAddress, currencies])

  // Fetch hub balance for selected currency (with polling)
  useEffect(() => {
    if (
      !selectedChain ||
      !selectedCurrency ||
      !ownerAddress ||
      !isWalletCompatible
    ) {
      setHubBalance(null)
      return
    }
    setHubBalance(null)
    const fetchBalance = () => {
      getHubBalance(hubClient, HUB_CHAIN.relayHubAddress, {
        chainSlug: selectedChain.name,
        currency: selectedCurrency.address,
        owner: ownerAddress,
        ownerChainSlug: selectedChain.name,
        vmType: selectedChain.vmType,
      })
        .then(setHubBalance)
        .catch(() => setHubBalance(0n))
    }
    fetchBalance()
    const interval = setInterval(fetchBalance, 5_000)
    return () => clearInterval(interval)
  }, [selectedChain, selectedCurrency, ownerAddress, isWalletCompatible])

  const handleContinue = () => {
    if (!selectedChain || !selectedCurrency || !ownerAddress) return
    setFlowKey((k) => k + 1)
    setCommitted({
      chainId: String(selectedChain.id),
      chainSlug: selectedChain.name,
      currency: selectedCurrency.address,
      decimals: selectedCurrency.decimals,
      ownerAddress,
      ownerChainId: String(selectedChain.id),
      ownerChainSlug: selectedChain.name,
      vmType: selectedChain.vmType,
    })
  }

  const handleBack = () => {
    setCommitted(null)
    setResumeJobId(null)
    setAllJobs(getAllJobs())
    // Force balance refresh
    setHubBalance(null)
    if (
      selectedChain &&
      selectedCurrency &&
      ownerAddress &&
      isWalletCompatible
    ) {
      getHubBalance(hubClient, HUB_CHAIN.relayHubAddress, {
        chainSlug: selectedChain.name,
        currency: selectedCurrency.address,
        owner: ownerAddress,
        ownerChainSlug: selectedChain.name,
        vmType: selectedChain.vmType,
      })
        .then(setHubBalance)
        .catch(() => setHubBalance(0n))
    }
  }

  const handleResume = (jobId: string, params: any) => {
    setFlowKey((k) => k + 1)
    setCommitted({
      chainId: params.chainId,
      chainSlug: params.chainSlug,
      currency: params.currency,
      decimals: params.decimals ?? 18,
      ownerAddress: params.ownerAddress ?? params.owner ?? address ?? "",
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
        <WithdrawalFlow
          key={flowKey}
          {...committed}
          resumeJobId={resumeJobId}
        />
      </div>
    )
  }

  // Selection UI
  return (
    <div className="max-w-lg mx-auto space-y-4">
      <div className="card space-y-4">
        <h3 className="font-heading font-bold text-lg">Withdraw</h3>
        <p className="text-sm text-subtle">
          Withdraw your funds from the Relay Hub to your wallet on any supported
          chain.
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
              chains={supportedChains}
              selected={selectedChain}
              onSelect={setSelectedChain}
            />

            {/* Currency selector */}
            {selectedChain && (
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-sm text-subtle">Token</label>
                  <button
                    type="button"
                    className="text-xs text-primary font-medium hover:underline"
                    onClick={() => {
                      setUseCustomCurrency(!useCustomCurrency)
                      setSelectedCurrency(null)
                      setCustomAddress("")
                    }}
                  >
                    {useCustomCurrency ? "Select from list" : "Custom address"}
                  </button>
                </div>
                {useCustomCurrency ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      className="input font-mono w-full text-sm"
                      placeholder="Token contract address (0x...)"
                      value={customAddress}
                      onChange={(e) => {
                        const addr = e.target.value
                        setCustomAddress(addr)
                        setSelectedCurrency(null)
                        setCustomLookupFailed(false)
                        if (isAddress(addr) && selectedChain) {
                          setCustomLoading(true)
                          lookupToken(selectedChain.httpRpcUrl, addr)
                            .then((info) => {
                              setSelectedCurrency({
                                id: addr,
                                address: addr,
                                symbol: info.symbol,
                                name: info.symbol,
                                decimals: info.decimals,
                              })
                            })
                            .catch(() => {
                              setCustomLookupFailed(true)
                              // decimals=0 means user enters raw amount, parseUnits(x, 0) = BigInt(x)
                              setSelectedCurrency({
                                id: addr,
                                address: addr,
                                symbol: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
                                name: addr,
                                decimals: 0,
                              })
                            })
                            .finally(() => setCustomLoading(false))
                        }
                      }}
                    />
                    {customLoading && (
                      <div className="flex items-center gap-2 text-xs text-subtle">
                        <div className="spinner !w-3 !h-3" />
                        Looking up token...
                      </div>
                    )}
                    {customLookupFailed && (
                      <p className="text-xs text-amber-700">
                        Could not read token info. Enter the raw amount
                        (smallest unit) in the next step.
                      </p>
                    )}
                    {selectedCurrency &&
                      useCustomCurrency &&
                      !customLookupFailed && (
                        <div className="flex items-center gap-2 text-xs text-subtle p-2 bg-gray-50 rounded-lg">
                          <span className="font-medium text-default">
                            {selectedCurrency.symbol}
                          </span>
                          <span>({selectedCurrency.decimals} decimals)</span>
                        </div>
                      )}
                  </div>
                ) : (
                  <Dropdown
                    searchPlaceholder="Search tokens..."
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
                    items={currencies.map((curr) => {
                      const bal = currencyBalances[curr.address]
                      const balStr =
                        bal != null && bal > 0n
                          ? formatUnits(bal, curr.decimals)
                          : undefined
                      return {
                        key: curr.address,
                        icon: (
                          <TokenIcon
                            logoURI={curr.logoURI}
                            symbol={curr.symbol}
                            size={20}
                          />
                        ),
                        label: curr.symbol,
                        sublabel: balStr ? `${balStr} available` : curr.name,
                        onClick: () => setSelectedCurrency(curr),
                      }
                    })}
                  />
                )}
              </div>
            )}

            {/* Wallet compatibility warning */}
            {selectedChain && !isWalletCompatible && (
              <div className="p-3 rounded-xl border border-amber-200 bg-amber-50">
                <p className="text-sm text-amber-800">
                  Connect a {getVmDisplayName(selectedChain.vmType)} wallet to
                  withdraw from {selectedChain.displayName}.
                </p>
              </div>
            )}

            {/* Balance preview */}
            {selectedCurrency && isWalletCompatible && (
              <div className="p-3 bg-gray-50 rounded-xl space-y-2 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-subtle">Wallet</span>
                  <span
                    className="font-mono text-xs text-default hover:text-primary cursor-pointer transition-colors"
                    title={ownerAddress ?? ""}
                    onClick={async () => {
                      if (ownerAddress)
                        await navigator.clipboard.writeText(ownerAddress)
                    }}
                  >
                    {ownerAddress
                      ? `${ownerAddress.slice(0, 6)}...${ownerAddress.slice(-4)}`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-subtle">Available</span>
                  {hubBalance !== null ? (
                    hubBalance > 0n ? (
                      <span className="inline-flex items-center gap-1.5">
                        <TokenIcon
                          logoURI={selectedCurrency.logoURI}
                          symbol={selectedCurrency.symbol}
                          size={14}
                        />
                        <span className="font-mono font-medium text-default">
                          {formatUnits(hubBalance, selectedCurrency.decimals)}{" "}
                          {selectedCurrency.symbol}
                        </span>
                      </span>
                    ) : (
                      <span className="text-error">No balance</span>
                    )
                  ) : (
                    <span className="text-subtle">Loading...</span>
                  )}
                </div>
              </div>
            )}

            {/* Continue / Connect wallet */}
            {selectedChain && !isWalletCompatible ? (
              <button
                className="btn-primary w-full"
                onClick={() => {
                  setWalletFilter(
                    VM_CONFIG[selectedChain.vmType]?.dynamicChain as
                      | "EVM"
                      | "SOL"
                      | "BTC"
                      | "SUI"
                      | "TRON"
                  )
                  setShowLinkNewWalletModal(true)
                }}
              >
                Connect {getVmDisplayName(selectedChain.vmType)} Wallet
              </button>
            ) : (
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
            )}
          </>
        )}
      </div>

      {/* Withdrawal history */}
      {visibleJobs.length > 0 && (
        <div className="card space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="font-heading font-bold text-lg">History</h3>
            <span className="text-xs text-subtle">
              {visibleJobs.length} total
            </span>
          </div>
          {visibleJobs.slice(0, showAllHistory ? undefined : 5).map((job) => {
            const statusBadge = {
              processing: { class: "badge-info", label: "Processing" },
              ready: { class: "badge-warning", label: "Ready" },
              submitted: { class: "badge-info", label: "Confirming" },
              executed: { class: "badge-success", label: "Executed" },
              expired: { class: "badge-error", label: "Expired" },
              failed: { class: "badge-error", label: "Failed" },
            }[job.status] ?? { class: "badge-info", label: job.status }

            const rawAmount = job.validatedAmount ?? job.params.amount
            const decimals = job.params.decimals ?? 18
            let displayAmount: string
            try {
              displayAmount = rawAmount
                ? formatUnits(BigInt(rawAmount), decimals)
                : "—"
            } catch {
              displayAmount = rawAmount ?? "—"
            }

            return (
              <button
                key={job.jobId}
                className="p-3 bg-gray-50 rounded-xl flex items-center justify-between w-full text-left hover:bg-gray-100 transition-colors cursor-pointer"
                onClick={() => handleResume(job.jobId, job.params)}
              >
                <div className="min-w-0 flex items-center gap-3">
                  <ChainIcon chainId={Number(job.params.chainId)} size={28} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {displayAmount}
                      </span>
                      <span className={`badge ${statusBadge.class}`}>
                        {statusBadge.label}
                      </span>
                    </div>
                    <div className="text-xs text-subtle">
                      {job.params.chainSlug} &middot;{" "}
                      {new Date(job.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
                <span className="text-gray-400 flex-shrink-0 ml-2">
                  &#8250;
                </span>
              </button>
            )
          })}
          {visibleJobs.length > 5 && (
            <button
              className="w-full text-center text-sm text-primary hover:underline py-1"
              onClick={() => setShowAllHistory(!showAllHistory)}
            >
              {showAllHistory
                ? "Show less"
                : `Show all (${visibleJobs.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
