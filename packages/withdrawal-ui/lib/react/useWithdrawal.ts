"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { Connection } from "@solana/web3.js"
import { usePublicClient, useWalletClient } from "wagmi"
import { useUserWallets } from "@dynamic-labs/sdk-react-core"
import { parseUnits } from "viem"
import {
  type WithdrawalConfig,
  type WithdrawalState,
  type WithdrawalStep,
  FAIL_REASON_MESSAGES,
} from "@/lib/core/withdrawal/types"
import {
  prepareWithdrawal,
  executeWithdrawal,
  getWithdrawalStatus,
} from "@/lib/core/withdrawal/api"
import {
  computeWithdrawalDigest,
  signWithdrawalDigest,
} from "@/lib/core/withdrawal/signing"
import {
  submitTransaction,
  pollSolanaConfirmation,
  pollTronConfirmation,
} from "@/lib/core/withdrawal/submit"
import { getHubBalance } from "@/lib/core/withdrawal/balance"
import {
  saveWithdrawalJob,
  updateJobStatus,
  getJob,
} from "@/lib/core/withdrawal/session"
import { getChain } from "@/lib/core/withdrawal/chains"
import { HUB_CHAIN, hubClient } from "@/lib/config"
import { toDynamicChain } from "@/lib/core/withdrawal/vmTypes"

const INITIAL_STATE: WithdrawalState = { step: "idle" }
const POLL_INTERVAL = 5_000
const POLL_INTERVAL_BACKOFF = 15_000
const POLL_TIMEOUT = 30 * 60 * 1000 // 30 minutes max polling

export function useWithdrawal(
  config: WithdrawalConfig,
  options?: { testMode?: boolean }
) {
  const testMode = options?.testMode ?? false
  const withdrawalChainClient = usePublicClient({
    chainId: Number(config.chainId),
  })
  const { data: evmWalletClient } = useWalletClient()
  const userWallets = useUserWallets()

  // ownerAddress from config — the correct wallet address for this chain's VM type
  const ownerAddress = config.ownerAddress

  // Get the correct wallet for this VM type
  // EVM: use wagmi walletClient (bridged from Dynamic)
  // Non-EVM: use Dynamic wallet directly
  const activeWallet = (() => {
    if (config.vmType === "evm" || config.vmType === "hypevm") {
      return evmWalletClient
    }
    const dynamicChain = toDynamicChain(config.vmType)
    if (!dynamicChain) return null
    const wallet = userWallets.find(
      (w) => w.chain === dynamicChain && w.address === ownerAddress
    )
    return wallet ?? null
  })()

  const [state, setState] = useState<WithdrawalState>(INITIAL_STATE)
  const [hubBalance, setHubBalance] = useState<bigint | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch hub balance (or mock in testMode)
  useEffect(() => {
    if (!ownerAddress) return
    if (testMode) {
      // Mock 1 full unit of the token so the UI can proceed
      setHubBalance(parseUnits("1", config.decimals))
      return
    }
    setHubBalance(null)
    getHubBalance(hubClient, HUB_CHAIN.relayHubAddress, {
      chainSlug: config.chainSlug,
      currency: config.currency,
      owner: ownerAddress,
      ownerChainSlug: config.ownerChainSlug,
      vmType: config.vmType,
    })
      .then(setHubBalance)
      .catch(() => setHubBalance(null))
  }, [
    testMode,
    ownerAddress,
    config.chainSlug,
    config.currency,
    config.decimals,
    config.ownerChainSlug,
    config.vmType,
  ])

  const setStep = useCallback(
    (step: WithdrawalStep, patch?: Partial<WithdrawalState>) => {
      setState((prev) => ({ ...prev, ...patch, step, error: undefined }))
    },
    []
  )

  const setError = useCallback((error: string) => {
    setState((prev) => ({ ...prev, error }))
  }, [])

  const toErrorMessage = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : "Transaction failed"
    return message.includes("User denied") || message.includes("User rejected")
      ? "Transaction rejected"
      : message.length > 100
        ? message.slice(0, 100) + "..."
        : message
  }, [])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  /** Wait for on-chain confirmation — dispatched per VM type */
  const waitForTransactionConfirmation = useCallback(
    async (txHash: string, jobId?: string) => {
      const markDone = (error?: string) => {
        setState((prev) => ({ ...prev, step: "done", txHash, error }))
        if (jobId) {
          if (error) updateJobStatus(jobId, "failed", { txHash, error })
          else updateJobStatus(jobId, "executed", { txHash })
        }
      }

      try {
        switch (config.vmType) {
          case "evm": {
            if (!withdrawalChainClient) return
            const receipt =
              await withdrawalChainClient.waitForTransactionReceipt({
                hash: txHash as `0x${string}`,
              })
            if (receipt.status === "reverted") {
              markDone("Transaction reverted on-chain")
              return
            }
            markDone()
            return
          }
          case "svm": {
            const chainInfo = await getChain(Number(config.chainId))
            if (!chainInfo?.httpRpcUrl)
              throw new Error("Solana RPC URL not available")
            const connection = new Connection(chainInfo.httpRpcUrl, "confirmed")
            try {
              await pollSolanaConfirmation(connection, txHash)
            } catch (err) {
              markDone(
                err instanceof Error ? err.message : "Transaction failed"
              )
              return
            }
            markDone()
            return
          }
          case "tvm": {
            const tronWeb =
              (activeWallet as any)?.getTronWeb?.() ??
              (globalThis as any).tronWeb
            if (!tronWeb) throw new Error("TronWeb not available")
            try {
              await pollTronConfirmation(tronWeb, txHash)
            } catch (err) {
              markDone(
                err instanceof Error ? err.message : "Transaction reverted"
              )
              return
            }
            markDone()
            return
          }
          default:
            // bvm, hypevm, suivm: solver tracks confirmation
            markDone()
        }
      } catch (err) {
        const error = toErrorMessage(err)
        setState((prev) => ({ ...prev, step: "submitting", txHash, error }))
      }
    },
    [
      activeWallet,
      config.vmType,
      config.chainId,
      toErrorMessage,
      withdrawalChainClient,
    ]
  )

  /** Step 1: Prepare — call API to get nonce (or generate locally in testMode) */
  const prepare = useCallback(
    async (amount: string, recipient: string) => {
      if (!ownerAddress) return
      setStep("preparing")

      try {
        const rawAmount = parseUnits(amount, config.decimals).toString()

        if (testMode) {
          // Generate nonce locally — no backend call
          const nonce = `0x${Array.from(
            crypto.getRandomValues(new Uint8Array(32))
          )
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")}`
          setStep("signing", { nonce, validatedAmount: rawAmount })
          return
        }

        const params = {
          chainId: config.chainSlug,
          currency: config.currency,
          amount: rawAmount,
          ownerChainId: config.ownerChainSlug,
          owner: ownerAddress,
          recipient,
        }
        const result = await prepareWithdrawal(params)
        setStep("signing", {
          nonce: result.nonce,
          additionalData: result.additionalData,
          validatedAmount: result.amount,
        })
      } catch (err) {
        setState((prev) => ({
          ...prev,
          step: "idle",
          error: err instanceof Error ? err.message : "Prepare failed",
        }))
      }
    },
    [testMode, ownerAddress, config, setStep, setError]
  )

  /** Step 2: Sign — compute digest, sign with wallet */
  const sign = useCallback(
    async (_amount: string, recipient: string) => {
      if (
        !activeWallet ||
        !ownerAddress ||
        !state.nonce ||
        !state.validatedAmount
      )
        return
      setStep("signing")

      try {
        // Use the validated amount from prepare (solver may have adjusted it)
        const amount = state.validatedAmount

        const digest = computeWithdrawalDigest({
          chainId: config.chainSlug,
          currency: config.currency,
          amount,
          ownerChainId: config.ownerChainSlug,
          owner: ownerAddress,
          recipient,
          nonce: state.nonce,
          additionalData: state.additionalData,
        })

        const signature = await signWithdrawalDigest(
          config.vmType,
          digest,
          activeWallet
        )

        // testMode: display digest + signature for manual review, skip submission
        if (testMode) {
          console.log("[TESTMODE] digest:", digest)
          console.log("[TESTMODE] signature:", signature)
          setState((prev) => ({
            ...prev,
            step: "signing",
            testModeResult: { digest, signature },
          }))
          return
        }

        // Step 3: Execute — submit signature
        setStep("executing")
        const result = await executeWithdrawal({
          chainId: config.chainSlug,
          currency: config.currency,
          amount,
          ownerChainId: config.ownerChainSlug,
          owner: ownerAddress,
          recipient,
          nonce: state.nonce,
          additionalData: state.additionalData,
          signature,
        })

        // Persist job for session recovery
        saveWithdrawalJob(
          result.jobId,
          { ...config, amount, owner: ownerAddress, recipient },
          { nonce: state.nonce, validatedAmount: amount }
        )

        setStep("polling", { jobId: result.jobId })
        startPolling(result.jobId)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Signing failed")
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeWallet,
      ownerAddress,
      config,
      state.nonce,
      state.validatedAmount,
      state.additionalData,
      setStep,
      setError,
    ]
  )

  /** Step 4: Poll status until ready/executed/failed */
  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling()
      let interval = POLL_INTERVAL
      const startTime = Date.now()

      const poll = async () => {
        // Timeout — stop polling after max duration
        if (Date.now() - startTime > POLL_TIMEOUT) {
          stopPolling()
          setState((prev) => ({
            ...prev,
            step: "done",
            error:
              "Withdrawal is taking longer than expected. Check back later.",
          }))
          return
        }

        try {
          const result = await getWithdrawalStatus(jobId)
          setState((prev) => ({ ...prev, jobStatus: result.status }))

          if (result.status === "ready") {
            stopPolling()
            updateJobStatus(jobId, "ready", {
              transaction: result.transaction,
              withdrawal: result.withdrawal,
            })
            setState((prev) => ({
              ...prev,
              step: "submitting",
              transaction: result.transaction,
            }))
            return
          } else if (result.status === "executed") {
            stopPolling()
            updateJobStatus(jobId, "executed")
            setState((prev) => ({ ...prev, step: "done" }))
            return
          } else if (result.status === "expired") {
            stopPolling()
            updateJobStatus(jobId, "expired", {
              error: "Withdrawal expired",
            })
            setState((prev) => ({
              ...prev,
              step: "done",
              failReason: "internal_error",
              error: "Withdrawal expired",
            }))
            return
          } else if (result.status === "failed") {
            stopPolling()
            updateJobStatus(jobId, "failed", {
              error: result.reason
                ? FAIL_REASON_MESSAGES[result.reason]
                : "Withdrawal failed",
              failReason: result.reason,
            })
            setState((prev) => ({
              ...prev,
              step: "done",
              failReason: result.reason,
              error: result.reason ?? "Withdrawal failed",
            }))
            return
          }
          // Still in-progress — reset backoff to normal rate if needed
          if (interval !== POLL_INTERVAL) {
            stopPolling()
            interval = POLL_INTERVAL
            pollRef.current = setInterval(poll, interval)
          }
        } catch (err) {
          if (err instanceof Error && err.message === "rate_limited") {
            // Back off on rate limit, notify user
            stopPolling()
            interval = POLL_INTERVAL_BACKOFF
            setState((prev) => ({
              ...prev,
              error: "Rate limited, slowing down...",
            }))
            pollRef.current = setInterval(poll, interval)
          }
        }
      }

      poll() // Initial immediate poll
      pollRef.current = setInterval(poll, interval)
    },
    [stopPolling]
  )

  /** Step 5: Submit on-chain transaction — dispatched per VM type */
  const submit = useCallback(async () => {
    if (!activeWallet || !state.transaction) return
    setStep("submitting")

    try {
      // Get chain RPC URL for non-EVM chains (Solana, Bitcoin need direct RPC access)
      const chainInfo = await getChain(Number(config.chainId))
      const rpcUrl = chainInfo?.httpRpcUrl

      const hash = await submitTransaction(
        config.vmType,
        state.transaction,
        activeWallet,
        rpcUrl
      )
      setState((prev) => ({
        ...prev,
        step: "submitting",
        txHash: hash,
        error: undefined,
      }))
      if (state.jobId)
        updateJobStatus(state.jobId, "submitted", {
          txHash: hash,
          transaction: state.transaction,
        })

      await waitForTransactionConfirmation(hash, state.jobId)
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }, [
    activeWallet,
    config.vmType,
    config.chainId,
    state.transaction,
    state.jobId,
    setStep,
    setError,
    toErrorMessage,
    waitForTransactionConfirmation,
  ])

  /** Resume a pending withdrawal by jobId — restore state from session */
  const resume = useCallback(
    (jobId: string) => {
      const stored = getJob(jobId)
      if (
        stored?.status === "submitted" ||
        (stored?.status === "ready" && stored.txHash)
      ) {
        setState({
          ...INITIAL_STATE,
          step: "submitting",
          jobId,
          transaction: stored.transaction,
          txHash: stored.txHash,
          validatedAmount: stored.validatedAmount,
          error: stored.error,
        })
        if (stored.txHash) {
          void waitForTransactionConfirmation(stored.txHash, jobId)
        }
      } else if (stored?.status === "ready" && stored.transaction) {
        setState({
          ...INITIAL_STATE,
          step: "submitting",
          jobId,
          transaction: stored.transaction,
          validatedAmount: stored.validatedAmount,
        })
      } else if (
        stored?.status === "executed" ||
        stored?.status === "expired" ||
        stored?.status === "failed"
      ) {
        setState({
          ...INITIAL_STATE,
          step: "done",
          jobId,
          txHash: stored.txHash,
          validatedAmount: stored.validatedAmount,
          error:
            stored.error ??
            (stored.status === "expired"
              ? "Withdrawal expired"
              : stored.status === "failed" && !stored.failReason
                ? "Withdrawal failed"
                : undefined),
          failReason: stored.failReason,
        })
      } else {
        // Still processing — poll
        setState({ ...INITIAL_STATE, step: "polling", jobId })
        startPolling(jobId)
      }
    },
    [startPolling, waitForTransactionConfirmation]
  )

  /** Reset to initial state and refresh balance */
  const reset = useCallback(() => {
    stopPolling()
    setState(INITIAL_STATE)
    setHubBalance(null)
    if (ownerAddress) {
      getHubBalance(hubClient, HUB_CHAIN.relayHubAddress, {
        chainSlug: config.chainSlug,
        currency: config.currency,
        owner: ownerAddress,
        ownerChainSlug: config.ownerChainSlug,
        vmType: config.vmType,
      })
        .then(setHubBalance)
        .catch(() => setHubBalance(null))
    }
  }, [
    stopPolling,
    ownerAddress,
    config.chainSlug,
    config.currency,
    config.ownerChainSlug,
    config.vmType,
  ])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  return {
    state,
    hubBalance,
    prepare,
    sign,
    resume,
    submit,
    reset,
  }
}
