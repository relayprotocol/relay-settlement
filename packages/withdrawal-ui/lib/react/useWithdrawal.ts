"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { useAccount, useWalletClient } from "wagmi"
import { parseUnits } from "viem"
import {
  type WithdrawalConfig,
  type WithdrawalState,
  type WithdrawalStep,
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
import { submitTransaction } from "@/lib/core/withdrawal/submit"
import { getHubBalance } from "@/lib/core/withdrawal/balance"
import {
  saveWithdrawalJob,
  updateJobStatus,
  getJob,
} from "@/lib/core/withdrawal/session"
import { HUB_CHAIN, hubClient } from "@/lib/config"

const INITIAL_STATE: WithdrawalState = { step: "idle" }
const POLL_INTERVAL = 5_000
const POLL_INTERVAL_BACKOFF = 15_000
const POLL_TIMEOUT = 30 * 60 * 1000 // 30 minutes max polling

export function useWithdrawal(config: WithdrawalConfig) {
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient()

  const [state, setState] = useState<WithdrawalState>(INITIAL_STATE)
  const [hubBalance, setHubBalance] = useState<bigint | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch hub balance when address or config changes
  useEffect(() => {
    if (!address) return
    setHubBalance(null)
    getHubBalance(hubClient, HUB_CHAIN.relayHubAddress, {
      chainSlug: config.chainSlug,
      currency: config.currency,
      owner: address,
      ownerChainSlug: config.ownerChainSlug,
      vmType: config.vmType,
    })
      .then(setHubBalance)
      .catch(() => setHubBalance(null))
  }, [
    address,
    config.chainSlug,
    config.currency,
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

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  /** Step 1: Prepare — call API to get nonce */
  const prepare = useCallback(
    async (amount: string, recipient: string) => {
      if (!address) return
      setStep("preparing")

      try {
        const rawAmount = parseUnits(amount, config.decimals).toString()
        const params = {
          chainId: config.chainSlug,
          currency: config.currency,
          amount: rawAmount,
          ownerChainId: config.ownerChainSlug,
          owner: address,
          recipient,
        }
        const result = await prepareWithdrawal(params)
        setStep("signing", {
          nonce: result.nonce,
          additionalData: result.additionalData,
          // Store the validated amount from solver (may differ from requested)
          validatedAmount: result.amount,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : "Prepare failed")
      }
    },
    [address, config, setStep, setError]
  )

  /** Step 2: Sign — compute digest, sign with wallet */
  const sign = useCallback(
    async (_amount: string, recipient: string) => {
      if (!walletClient || !address || !state.nonce || !state.validatedAmount)
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
          owner: address,
          recipient,
          nonce: state.nonce,
          additionalData: state.additionalData,
        })

        const signature = await signWithdrawalDigest(
          config.vmType,
          digest,
          walletClient
        )

        // Step 3: Execute — submit signature
        setStep("executing")
        const result = await executeWithdrawal({
          chainId: config.chainSlug,
          currency: config.currency,
          amount,
          ownerChainId: config.ownerChainSlug,
          owner: address,
          recipient,
          nonce: state.nonce,
          additionalData: state.additionalData,
          signature,
        })

        // Persist job for session recovery
        saveWithdrawalJob(
          result.jobId,
          { ...config, amount, owner: address, recipient },
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
      walletClient,
      address,
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
          } else if (result.status === "executed") {
            stopPolling()
            updateJobStatus(jobId, "executed")
            setState((prev) => ({ ...prev, step: "done" }))
          } else if (result.status === "expired") {
            stopPolling()
            updateJobStatus(jobId, "expired")
            setState((prev) => ({
              ...prev,
              step: "done",
              failReason: "internal_error",
              error: "Withdrawal expired",
            }))
          } else if (result.status === "failed") {
            stopPolling()
            updateJobStatus(jobId, "failed")
            setState((prev) => ({
              ...prev,
              step: "done",
              failReason: result.reason,
              error: result.reason ?? "Withdrawal failed",
            }))
          }
          // Reset backoff on success
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
    if (!walletClient || !state.transaction) return
    setStep("submitting")

    try {
      const hash = await submitTransaction(
        config.vmType,
        state.transaction,
        walletClient
      )

      setState((prev) => ({ ...prev, txHash: hash, step: "done" }))
      if (state.jobId)
        updateJobStatus(state.jobId, "executed", { txHash: hash })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transaction failed"
      const short =
        message.includes("User denied") || message.includes("User rejected")
          ? "Transaction rejected"
          : message.length > 100
            ? message.slice(0, 100) + "..."
            : message
      setError(short)
    }
  }, [
    walletClient,
    config.vmType,
    state.transaction,
    state.jobId,
    setStep,
    setError,
  ])

  /** Resume a pending withdrawal by jobId — restore state from session */
  const resume = useCallback(
    (jobId: string) => {
      const stored = getJob(jobId)
      if (stored?.status === "ready" && stored.txHash) {
        // Tx already submitted — show done
        setState({
          ...INITIAL_STATE,
          step: "done",
          jobId,
          txHash: stored.txHash,
        })
      } else if (stored?.status === "ready" && stored.transaction) {
        // Ready to submit — skip polling, go straight to submit step
        setState({
          ...INITIAL_STATE,
          step: "submitting",
          jobId,
          transaction: stored.transaction,
        })
      } else if (
        stored?.status === "executed" ||
        stored?.status === "expired" ||
        stored?.status === "failed"
      ) {
        // Already done — show final state
        setState({
          ...INITIAL_STATE,
          step: "done",
          jobId,
          txHash: stored.txHash,
          error: stored.status === "expired" ? "Withdrawal expired" : undefined,
          failReason: stored.status === "failed" ? "internal_error" : undefined,
        })
      } else {
        // Still processing — poll
        setState({ ...INITIAL_STATE, step: "polling", jobId })
        startPolling(jobId)
      }
    },
    [startPolling]
  )

  /** Reset to initial state */
  const reset = useCallback(() => {
    stopPolling()
    setState(INITIAL_STATE)
  }, [stopPolling])

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
