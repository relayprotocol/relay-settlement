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
    limit: 1000,
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

  if (tx.data && tx.data !== "0x") {
    try {
      const decoded = await apiKit.decodeData(tx.data, tx.to)

      const isMultiSend =
        decoded?.method === "multiSend" ||
        decoded?.method === "multiSendCallOnly"

      if (isMultiSend) {
        const inner = decoded?.parameters?.[0]?.valueDecoded ?? []
        actions = inner.map((it: any) => ({
          data: it.data ?? "0x",
          dataDecoded: it.dataDecoded,
          operation: it.operation ?? 0,
          to: it.to,
          value: String(it.value ?? "0"),
        }))
      } else {
        actions[0].dataDecoded = decoded
      }
    } catch {
      // swallow decode errors; keep raw single action
    }
  }
  return actions
}

export const createSafeClientWithRpc = async (
  rpc: string,
  safeAddress: `0x${string}`
) => {
  const signer = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY
  if (!signer) {
    throw new Error(
      "Set DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) in the environment."
    )
  }
  return await createSafeClient({
    apiKey: process.env.SAFE_API_KEY!,
    provider: rpc,
    safeAddress,
    signer,
  })
}
