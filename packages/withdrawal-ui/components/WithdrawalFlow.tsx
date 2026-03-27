"use client"

import { useState, useEffect } from "react"
import { useSwitchChain } from "wagmi"
import { formatUnits, parseUnits } from "viem"
import { useWithdrawal } from "@/lib/react/useWithdrawal"
import { showToast } from "./Toast"
import { StepTimeline, type StepInfo } from "./StepTimeline"
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
import { ChainIcon, TokenIcon } from "./ChainTokenIcon"
import { CheckCircleIcon, ErrorCircleIcon } from "./Icons"

/** A row with label + truncated value that copies on click */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const truncated = value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "—"

  const handleCopy = async () => {
    if (!value) return
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="flex justify-between cursor-pointer group"
      onClick={handleCopy}
      title={value}
    >
      <span className="text-subtle">{label}</span>
      <span className="font-mono text-xs text-default group-hover:text-primary transition-colors">
        {copied ? "Copied!" : truncated}
      </span>
    </div>
  )
}

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
  const { chainId, currency, ownerAddress, vmType, resumeJobId } = props
  const { switchChainAsync } = useSwitchChain()
  const { state, hubBalance, prepare, sign, resume, submit, reset } =
    useWithdrawal(props)
  const finalError = state.failReason
    ? FAIL_REASON_MESSAGES[state.failReason]
    : state.error
  const doneToastError = state.step === "done" ? finalError : undefined
  const submittingToastState =
    state.step === "submitting"
      ? state.txHash
        ? "submitted"
        : "ready"
      : undefined
  const toastState =
    state.step === "polling"
      ? (state.jobStatus ?? "polling")
      : state.step === "submitting"
        ? (submittingToastState ?? "submitting")
        : state.step

  // Resume pending job on mount
  useEffect(() => {
    if (resumeJobId) {
      resume(resumeJobId)
    }
  }, [resumeJobId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Toast on step transitions
  useEffect(() => {
    const toasts: Record<
      string,
      {
        title: string
        description?: string
        type: "info" | "success" | "error"
      }
    > = {
      preparing: {
        title: "Preparing",
        description: "Requesting withdrawal details from solver...",
        type: "info",
      },
      signing: {
        title: "Signature Required",
        description: "Please confirm the signature in your wallet.",
        type: "info",
      },
      executing: {
        title: "Submitting",
        description: "Sending signed request to solver...",
        type: "info",
      },
      initiating: {
        title: "Initiating Transfer",
        description: "The solver is preparing your withdrawal.",
        type: "info",
      },
      attesting: {
        title: "Waiting for Attestation",
        description: "The withdrawal is waiting for attestation.",
        type: "info",
      },
      polling: {
        title: "Processing",
        description:
          "Your withdrawal is being processed. This may take a few minutes.",
        type: "info",
      },
      submitting: {
        title:
          submittingToastState === "submitted"
            ? "Transaction Submitted"
            : "Ready to Submit",
        description:
          submittingToastState === "submitted"
            ? "Waiting for on-chain confirmation."
            : "Submit the on-chain transaction to receive your funds.",
        type: submittingToastState === "submitted" ? "info" : "success",
      },
      done: doneToastError
        ? {
            title: "Withdrawal Failed",
            description: doneToastError,
            type: "error",
          }
        : {
            title: "Withdrawal Complete",
            description: "Your funds have been sent to your wallet.",
            type: "success",
          },
    }
    const toast = toasts[toastState]
    if (toast)
      showToast(toast.title, {
        description: toast.description,
        type: toast.type,
      })
  }, [doneToastError, submittingToastState, toastState])

  const [amount, setAmount] = useState("")
  const [customRecipient, setCustomRecipient] = useState("")
  const [showCustomRecipient, setShowCustomRecipient] = useState(false)
  const [chainInfo, setChainInfo] = useState<ChainInfo | null>(null)
  const [currencyInfo, setCurrencyInfo] = useState<ChainCurrency | null>(null)

  // Recipient: custom or connected wallet
  const recipient =
    showCustomRecipient && customRecipient
      ? customRecipient
      : (ownerAddress ?? "")

  // Fetch chain and currency info from solver API
  useEffect(() => {
    getChain(Number(chainId)).then((c) => setChainInfo(c ?? null))
    findCurrency(Number(chainId), currency).then((c) =>
      setCurrencyInfo(c ?? null)
    )
  }, [chainId, currency])

  const currentStepIndex = stepToIndex(state.step)
  const tokenSymbol = currencyInfo?.symbol ?? "tokens"
  const tokenDecimals = currencyInfo?.decimals ?? props.decimals
  const isRawAmountMode = props.decimals === 0
  const [actionLoading, setActionLoading] = useState(false)

  // Validate amount — used for both error display and button disable
  const amountValidation = (() => {
    if (!amount) return { exceedsBalance: false, invalidFormat: false }
    try {
      parseUnits(amount, tokenDecimals)
      const exceedsBalance =
        hubBalance !== null && parseUnits(amount, tokenDecimals) > hubBalance
      return { exceedsBalance, invalidFormat: false }
    } catch {
      return { exceedsBalance: false, invalidFormat: true }
    }
  })()
  const hasAmountError =
    amountValidation.exceedsBalance || amountValidation.invalidFormat

  // Display amount: user input > validated amount from state (for resume)
  const displayAmount =
    amount ||
    (state.validatedAmount
      ? formatUnits(BigInt(state.validatedAmount), tokenDecimals)
      : "")

  // Default amount to max when balance loads — only on idle step
  useEffect(() => {
    if (
      state.step === "idle" &&
      hubBalance !== null &&
      hubBalance > 0n &&
      !amount
    ) {
      setAmount(formatUnits(hubBalance, tokenDecimals))
    }
  }, [hubBalance, tokenDecimals, state.step]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setActionLoading(true)
    await sign(amount, recipient)
    setActionLoading(false)
  }

  const handleSubmit = async () => {
    setActionLoading(true)
    // Chain switch only applies to EVM — abort on any failure to avoid wrong-chain submit
    if (vmType === "evm" && state.transaction) {
      try {
        await switchChainAsync({ chainId: state.transaction.chainId })
      } catch {
        setActionLoading(false)
        return
      }
    }
    await submit()
    setActionLoading(false)
  }

  // Shared withdrawal summary — used in Sign, Processing, Submit, Done steps
  const withdrawalSummary = (extra?: { txHash?: string }) => (
    <div className="p-4 bg-gray-50 rounded-xl text-sm space-y-3">
      {/* Amount — prominent display */}
      <div className="flex items-center gap-2 pb-2 border-b border-gray-200">
        <TokenIcon
          logoURI={currencyInfo?.logoURI}
          symbol={tokenSymbol}
          size={24}
        />
        <span className="text-lg font-bold text-default">
          {displayAmount || "—"} {tokenSymbol}
        </span>
      </div>

      {/* Details — consistent label:value rows */}
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-subtle">Network</span>
          <span className="inline-flex items-center gap-1.5">
            <ChainIcon chainId={Number(chainId)} size={14} />
            <span className="text-default">
              {chainInfo?.displayName ?? chainId}
            </span>
          </span>
        </div>
        <CopyRow label="Recipient" value={recipient} />
        {extra?.txHash && <CopyRow label="Transaction" value={extra.txHash} />}
      </div>
    </div>
  )

  const handleReset = () => {
    setAmount("")
    setActionLoading(false)
    reset()
  }

  return (
    <div className="max-w-lg mx-auto space-y-4">
      {/* Step Timeline */}
      <StepTimeline steps={STEPS} currentStepIndex={currentStepIndex} />

      {/* Step Content */}
      <div className="card space-y-4">
        {/* Error banner — inside card, always visible */}
        {state.error && state.step !== "done" && (
          <div className="p-3 rounded-xl border border-red-200 bg-red-50 overflow-hidden">
            <div className="flex items-start gap-3">
              <ErrorCircleIcon className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-error break-words min-w-0">
                {state.error}
              </span>
            </div>
          </div>
        )}

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
                <span className="text-sm text-subtle">Available</span>
                <span className="inline-flex items-center gap-1.5">
                  <TokenIcon
                    logoURI={currencyInfo?.logoURI}
                    symbol={tokenSymbol}
                    size={16}
                  />
                  <span className="text-sm font-mono font-medium text-default">
                    {formatUnits(hubBalance, tokenDecimals)} {tokenSymbol}
                  </span>
                </span>
              </div>
            )}

            {/* Amount */}
            <div>
              {isRawAmountMode && (
                <div className="p-2.5 rounded-lg border border-amber-200 bg-amber-50 mb-3">
                  <p className="text-xs text-amber-800">
                    Token decimals unknown. Enter the raw amount in smallest
                    units (e.g. wei).
                  </p>
                </div>
              )}
              <div className="flex justify-between items-center mb-1">
                <label className="text-sm text-subtle">
                  {isRawAmountMode ? "Raw Amount" : "Amount"}
                </label>
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
              <>
                <div className="relative">
                  <input
                    type="text"
                    className={`input font-mono pr-16 ${hasAmountError ? "border-red-300 focus:border-red-400" : ""}`}
                    placeholder={
                      isRawAmountMode ? "1000000000000000000" : "0.00"
                    }
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={state.step === "preparing"}
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-subtle">
                    {tokenSymbol}
                  </span>
                </div>
                {amountValidation.exceedsBalance && (
                  <p className="text-xs text-error mt-1">
                    Exceeds available balance
                  </p>
                )}
                {amountValidation.invalidFormat && (
                  <p className="text-xs text-error mt-1">Invalid amount</p>
                )}
              </>
            </div>

            {/* Recipient */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-sm text-subtle">Withdraw to</label>
                <button
                  type="button"
                  className="text-xs text-primary font-medium hover:underline"
                  onClick={() => {
                    setShowCustomRecipient(!showCustomRecipient)
                    if (showCustomRecipient) setCustomRecipient("")
                  }}
                >
                  {showCustomRecipient ? "Use my wallet" : "Send to other"}
                </button>
              </div>
              {showCustomRecipient ? (
                <input
                  type="text"
                  className="input font-mono text-sm"
                  placeholder="Enter recipient address"
                  value={customRecipient}
                  onChange={(e) => setCustomRecipient(e.target.value)}
                  disabled={state.step === "preparing"}
                />
              ) : (
                <div className="p-3 bg-gray-50 rounded-xl flex justify-between items-center">
                  <span className="text-xs text-subtle">Your wallet</span>
                  <span
                    className="font-mono text-xs text-default hover:text-primary cursor-pointer transition-colors"
                    title={ownerAddress}
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
              )}
            </div>

            {/* Withdraw Button */}
            <button
              className="btn-primary w-full"
              onClick={handlePrepare}
              disabled={
                state.step === "preparing" ||
                !amount ||
                !recipient ||
                hasAmountError
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

            {withdrawalSummary()}

            <p className="text-xs text-subtle">
              You will be asked to sign a message to authorize this withdrawal.
              This is a free signature — no gas fee required.
            </p>

            <button
              className="btn-primary w-full"
              onClick={handleSign}
              disabled={actionLoading}
            >
              {actionLoading ? (
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

            {withdrawalSummary()}

            {/* Status progress */}
            <div className="flex items-center gap-3 p-3">
              <div className="spinner" />
              <div>
                <p className="text-default font-medium">
                  {state.jobStatus === "initiating"
                    ? "Initiating transfer..."
                    : state.jobStatus === "attesting"
                      ? "Waiting for attestation..."
                      : "Processing withdrawal..."}
                </p>
                <p className="text-xs text-subtle mt-1">
                  This may take a few minutes. You can safely close this page
                  and come back later.
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

            {withdrawalSummary(
              state.txHash ? { txHash: state.txHash } : undefined
            )}

            {state.txHash ? (
              <div className="flex items-center gap-3 p-3">
                <div className="spinner" />
                <div>
                  <p className="text-default font-medium">
                    Transaction submitted
                  </p>
                  <p className="text-xs text-subtle mt-1">
                    Waiting for on-chain confirmation.
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-subtle">
                Your withdrawal is ready. Submit the on-chain transaction to
                receive your funds. This will require a small gas fee.
              </p>
            )}

            {state.txHash ? null : (
              <button
                className="btn-primary w-full"
                onClick={handleSubmit}
                disabled={!state.transaction || actionLoading}
              >
                {actionLoading ? (
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
            )}
          </>
        ) : null}

        {/* Step 5: Done */}
        {state.step === "done" ? (
          <>
            {state.txHash ? (
              <>
                <div className="flex items-center gap-3">
                  <CheckCircleIcon />
                  <h3 className="font-heading font-bold text-lg text-green-700">
                    Withdrawal Complete
                  </h3>
                </div>

                {withdrawalSummary({ txHash: state.txHash })}

                {chainInfo?.explorerUrl && (
                  <a
                    href={`${chainInfo.explorerUrl}/tx/${state.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary w-full text-center"
                  >
                    View on {chainInfo.displayName} Explorer
                  </a>
                )}
              </>
            ) : state.error || state.failReason ? (
              <>
                <div className="flex items-center gap-3">
                  <ErrorCircleIcon />
                  <h3 className="font-heading font-bold text-lg text-red-700">
                    Withdrawal Failed
                  </h3>
                </div>
                <p className="text-sm text-error">{finalError}</p>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <CheckCircleIcon />
                <h3 className="font-heading font-bold text-lg text-green-700">
                  Withdrawal Complete
                </h3>
              </div>
            )}

            <button className="btn-secondary w-full" onClick={handleReset}>
              New Withdrawal
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
