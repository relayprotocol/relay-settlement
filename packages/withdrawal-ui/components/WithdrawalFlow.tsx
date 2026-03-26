"use client"

import { useState, useEffect } from "react"
import { useAccount, useSwitchChain } from "wagmi"
import { formatUnits, parseUnits } from "viem"
import { useWithdrawal } from "@/lib/react/useWithdrawal"
import { StepTimeline, type StepInfo } from "./StepTimeline"
import { CopyableAddress } from "./CopyableAddress"
import {
  getChain,
  findCurrency,
  type ChainInfo,
  type ChainCurrency,
} from "@/lib/core/withdrawal/chains"
import {
  type WithdrawalConfig,
  type WithdrawalStep,
  FAIL_REASON_MESSAGES,
} from "@/lib/core/withdrawal/types"

const STEPS: StepInfo[] = [
  {
    key: "input",
    label: "Enter Details",
    description: "Enter amount and recipient address",
  },
  {
    key: "sign",
    label: "Sign",
    description: "Sign the withdrawal request with your wallet",
  },
  {
    key: "processing",
    label: "Processing",
    description: "Withdrawal is being processed",
  },
  {
    key: "submit",
    label: "Submit Transaction",
    description: "Submit the withdrawal transaction on-chain",
  },
  {
    key: "done",
    label: "Complete",
    description: "Withdrawal complete",
  },
]

function stepToIndex(step: WithdrawalStep): number {
  switch (step) {
    case "idle":
    case "preparing":
      return 0
    case "signing":
      return 1
    case "executing":
    case "polling":
      return 2
    case "submitting":
      return 3
    case "done":
      return 4
  }
}

interface WithdrawalFlowProps extends WithdrawalConfig {
  resumeJobId?: string | null
}

export function WithdrawalFlow(props: WithdrawalFlowProps) {
  const { chainId, currency, ownerChainId, resumeJobId } = props
  const { address } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { state, hubBalance, prepare, sign, resume, submit, reset } =
    useWithdrawal(props)

  // Resume pending job on mount
  useEffect(() => {
    if (resumeJobId) {
      resume(resumeJobId)
    }
  }, [resumeJobId]) // eslint-disable-line react-hooks/exhaustive-deps

  const [amount, setAmount] = useState("")
  const [chainInfo, setChainInfo] = useState<ChainInfo | null>(null)
  const [currencyInfo, setCurrencyInfo] = useState<ChainCurrency | null>(null)

  // Recipient defaults to connected wallet
  const recipient = address ?? ""

  // Fetch chain and currency info from solver API
  useEffect(() => {
    getChain(Number(chainId)).then((c) => setChainInfo(c ?? null))
    findCurrency(Number(chainId), currency).then((c) =>
      setCurrencyInfo(c ?? null)
    )
  }, [chainId, currency])

  const currentStepIndex = stepToIndex(state.step)
  const tokenSymbol = currencyInfo?.symbol ?? "tokens"
  const tokenDecimals = currencyInfo?.decimals ?? 18
  const [loading, setLoading] = useState(false)

  // Default amount to max when balance loads
  useEffect(() => {
    if (hubBalance !== null && hubBalance > 0n && !amount) {
      setAmount(formatUnits(hubBalance, tokenDecimals))
    }
  }, [hubBalance, tokenDecimals]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleMax = () => {
    if (hubBalance !== null) {
      setAmount(formatUnits(hubBalance, tokenDecimals))
    }
  }

  const handlePrepare = async () => {
    if (!amount || !recipient) return
    await prepare(amount, recipient)
  }

  const handleSign = async () => {
    if (!amount || !recipient) return
    setLoading(true)
    await sign(amount, recipient)
    setLoading(false)
  }

  const handleSubmit = async () => {
    setLoading(true)
    // Check chain and switch if needed
    if (state.transaction) {
      try {
        await switchChainAsync({ chainId: state.transaction.chainId })
      } catch {
        // User rejected chain switch — abort to avoid submitting on wrong chain
        setLoading(false)
        return
      }
    }
    await submit()
    setLoading(false)
  }

  const handleReset = () => {
    setAmount("")
    setLoading(false)
    reset()
  }

  return (
    <div className="max-w-lg mx-auto space-y-4">
      {/* Step Timeline */}
      <StepTimeline steps={STEPS} currentStepIndex={currentStepIndex} />

      {/* Step Content */}
      <div className="card space-y-4">
        {/* Step 1: Input */}
        {state.step === "idle" || state.step === "preparing" ? (
          <>
            <h3 className="font-heading font-bold text-lg">
              Withdraw {tokenSymbol}
              {chainInfo ? ` to ${chainInfo.displayName}` : ""}
            </h3>

            {/* Hub Balance */}
            {hubBalance !== null && (
              <div className="p-3 bg-gray-50 rounded-xl flex justify-between items-center">
                <div>
                  <span className="text-sm text-subtle">Available: </span>
                  <span className="text-sm font-mono font-medium text-default">
                    {formatUnits(hubBalance, tokenDecimals)} {tokenSymbol}
                  </span>
                </div>
              </div>
            )}

            {/* Amount */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-sm text-subtle">Amount</label>
                {hubBalance !== null && hubBalance > 0n && (
                  <button
                    type="button"
                    className="text-xs text-primary font-medium hover:underline"
                    onClick={handleMax}
                  >
                    Max
                  </button>
                )}
              </div>
              {(() => {
                let exceedsBalance = false
                let invalidFormat = false
                try {
                  if (amount) {
                    parseUnits(amount, tokenDecimals) // validate format
                    if (hubBalance !== null) {
                      exceedsBalance =
                        parseUnits(amount, tokenDecimals) > hubBalance
                    }
                  }
                } catch {
                  invalidFormat = !!amount
                }
                const hasError = exceedsBalance || invalidFormat
                return (
                  <>
                    <div className="relative">
                      <input
                        type="text"
                        className={`input font-mono pr-16 ${hasError ? "border-red-300 focus:border-red-400" : ""}`}
                        placeholder="0.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        disabled={state.step === "preparing"}
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-subtle">
                        {tokenSymbol}
                      </span>
                    </div>
                    {exceedsBalance && (
                      <p className="text-xs text-error mt-1">
                        Exceeds available balance
                      </p>
                    )}
                    {invalidFormat && (
                      <p className="text-xs text-error mt-1">Invalid amount</p>
                    )}
                  </>
                )
              })()}
            </div>

            {/* Recipient (read-only, shows connected wallet) */}
            <div>
              <label className="text-sm text-subtle block mb-1">
                Withdraw to
              </label>
              <div className="p-3 bg-gray-50 rounded-input font-mono text-sm text-default">
                {recipient}
              </div>
            </div>

            {/* Withdraw Button */}
            <button
              className="btn-primary w-full"
              onClick={handlePrepare}
              disabled={
                state.step === "preparing" ||
                !amount ||
                !recipient ||
                (() => {
                  try {
                    return (
                      hubBalance !== null &&
                      parseUnits(amount, tokenDecimals) > hubBalance
                    )
                  } catch {
                    return true
                  }
                })()
              }
            >
              {state.step === "preparing" ? (
                <>
                  <div className="spinner !w-4 !h-4 !border-white/30 !border-t-white" />
                  Preparing...
                </>
              ) : (
                "Withdraw"
              )}
            </button>
          </>
        ) : null}

        {/* Step 2: Sign */}
        {state.step === "signing" ? (
          <>
            <h3 className="font-heading font-bold text-lg">Review & Sign</h3>

            <div className="space-y-2 p-3 bg-gray-50 rounded-xl text-sm">
              <div className="flex justify-between">
                <span className="text-subtle">Chain</span>
                <span>{chainInfo?.displayName ?? chainId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-subtle">Amount</span>
                <span className="font-mono">
                  {amount} {tokenSymbol}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-subtle">Recipient</span>
                <CopyableAddress value={recipient} />
              </div>
              {state.nonce && (
                <div className="flex justify-between">
                  <span className="text-subtle">Nonce</span>
                  <CopyableAddress value={state.nonce} />
                </div>
              )}
            </div>

            <button
              className="btn-primary w-full"
              onClick={handleSign}
              disabled={loading}
            >
              {loading ? (
                <>
                  <div className="spinner !w-4 !h-4 !border-white/30 !border-t-white" />
                  Signing...
                </>
              ) : (
                "Sign with Wallet"
              )}
            </button>
          </>
        ) : null}

        {/* Step 3: Executing + Polling */}
        {state.step === "executing" || state.step === "polling" ? (
          <>
            <h3 className="font-heading font-bold text-lg">Processing</h3>

            <div className="flex items-center gap-3 p-4">
              <div className="spinner" />
              <div>
                <p className="text-default font-medium">
                  {state.jobStatus === "initiating"
                    ? "Initiating withdrawal..."
                    : state.jobStatus === "attesting"
                      ? "Waiting for attestation..."
                      : "Processing..."}
                </p>
              </div>
            </div>
          </>
        ) : null}

        {/* Step 4: Submit Transaction */}
        {state.step === "submitting" && state.transaction ? (
          <>
            <h3 className="font-heading font-bold text-lg">
              Submit Transaction
            </h3>

            <div className="space-y-2 p-3 bg-gray-50 rounded-xl text-sm">
              <div className="flex justify-between">
                <span className="text-subtle">Chain</span>
                <span className="font-mono">{state.transaction.chainId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-subtle">To</span>
                <CopyableAddress value={state.transaction.to} />
              </div>
              <div className="flex justify-between">
                <span className="text-subtle">Value</span>
                <span className="font-mono">
                  {state.transaction.value === "0"
                    ? "0"
                    : formatUnits(BigInt(state.transaction.value), 18)}{" "}
                  {chainInfo?.currency.symbol ?? "ETH"}
                </span>
              </div>
            </div>

            <button
              className="btn-primary w-full"
              onClick={handleSubmit}
              disabled={!state.transaction || loading}
            >
              {loading ? (
                <>
                  <div className="spinner !w-4 !h-4 !border-white/30 !border-t-white" />
                  Submitting...
                </>
              ) : state.error ? (
                "Retry Transaction"
              ) : (
                "Submit Transaction"
              )}
            </button>
          </>
        ) : null}

        {/* Step 5: Done */}
        {state.step === "done" ? (
          <>
            {state.txHash ? (
              <>
                <div className="flex items-center gap-3">
                  <svg
                    className="w-6 h-6 text-green-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <h3 className="font-heading font-bold text-lg text-green-700">
                    Withdrawal Submitted
                  </h3>
                </div>

                <div className="p-3 bg-gray-50 rounded-xl space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-subtle">Tx Hash</span>
                    <CopyableAddress value={state.txHash} />
                  </div>
                </div>

                {(() => {
                  const fallbackExplorers: Record<string, string> = {
                    "1": "https://etherscan.io",
                    "8453": "https://basescan.org",
                    "42161": "https://arbiscan.io",
                    "10": "https://optimistic.etherscan.io",
                    "137": "https://polygonscan.com",
                  }
                  const url =
                    chainInfo?.explorerUrl ?? fallbackExplorers[chainId]
                  return url ? (
                    <a
                      href={`${url}/tx/${state.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-secondary w-full text-center"
                    >
                      View on {chainInfo?.displayName ?? ""} Explorer
                    </a>
                  ) : null
                })()}
              </>
            ) : state.error || state.failReason ? (
              <>
                <div className="flex items-center gap-3">
                  <svg
                    className="w-6 h-6 text-red-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <h3 className="font-heading font-bold text-lg text-red-700">
                    Withdrawal Failed
                  </h3>
                </div>
                <p className="text-sm text-error">
                  {state.failReason
                    ? FAIL_REASON_MESSAGES[state.failReason]
                    : state.error}
                </p>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <svg
                  className="w-6 h-6 text-green-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <h3 className="font-heading font-bold text-lg text-green-700">
                  Withdrawal Executed
                </h3>
              </div>
            )}

            <button className="btn-secondary w-full" onClick={handleReset}>
              New Withdrawal
            </button>
          </>
        ) : null}
      </div>

      {/* Error banner */}
      {state.error && state.step !== "done" && (
        <div className="card border border-red-200 bg-red-50 overflow-hidden">
          <div className="flex items-start gap-3">
            <svg
              className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span className="text-sm text-error break-words min-w-0">
              {state.error}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
