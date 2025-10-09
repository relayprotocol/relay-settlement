import { createSafeClient } from "@safe-global/sdk-starter-kit"

export type SafeTransactionAction = {
  to: string
  value: string // decimal string (wei)
  data: string // 0x…
  operation: number // 0 = CALL, 1 = DELEGATECALL
  dataDecoded?: any // decoded ABI of the inner call (if available)
}

export const getPendingSafeTxActionsByNonce = async (
  apiKit: any,
  safeAddress: `0x${string}`,
  targetNonce: number
): Promise<SafeTransactionAction[]> => {
  const { results } = await apiKit.getPendingTransactions(safeAddress, {
    limit: 1000, // This breaks after 1000!
  })

  const tx = results.find(
    (transaction: any) => transaction.nonce === targetNonce
  )
  if (!tx) {
    throw new Error(
      `❌ Safe transaction not found for nonce ${targetNonce}. Please check the nonce and make sure the transaction is still pending!`
    )
  }
  let actions: SafeTransactionAction[] = [
    {
      data: tx.data || "0x",
      operation: tx.operation ?? 0,
      to: tx.to,
      value: tx.value,
    },
  ]

  // If there is calldata, try to decode it
  if (tx.data && tx.data !== "0x") {
    try {
      // Providing `to` improves accuracy in case of ABI collisions
      const decoded = await apiKit.decodeData(tx.data, tx.to)

      // Check if this is a MultiSend (method name varies by version)
      const isMultiSend =
        decoded?.method === "multiSend" ||
        decoded?.method === "multiSendCallOnly"

      if (isMultiSend) {
        // For MultiSend, actions live in parameters[0].valueDecoded (array)
        const inner = decoded?.parameters?.[0]?.valueDecoded ?? []
        actions = inner.map((it: any) => ({
          data: it.data ?? "0x",
          dataDecoded: it.dataDecoded, // may be undefined if ABI unknown
          operation: it.operation ?? 0,
          to: it.to,
          value: String(it.value ?? "0"),
        }))
      } else {
        // Not a batch: attach decoded ABI for convenience
        actions[0].dataDecoded = decoded
      }
    } catch {
      // Swallow decode errors; keep raw single action
    }
  }
  return actions
}

export const createSafeClientWithConfig = async (
  hre: any,
  safeAddress: string
) => {
  return await createSafeClient({
    apiKey: process.env.SAFE_API_KEY!,
    provider: hre.network.config.url,
    safeAddress: safeAddress as `0x${string}`,
    signer: process.env.DEPLOYER_PRIVATE_KEY,
  })
}
