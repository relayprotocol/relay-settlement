import { createSafeClient } from "@safe-global/sdk-starter-kit"
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem"

export type SafeTransactionAction = {
  to: string
  value: string // decimal string (wei)
  data: string // 0x…
  operation: number // 0 = CALL, 1 = DELEGATECALL
  dataDecoded?: any // decoded ABI of the inner call (if available)
}

export const getSafeTransactionByNonce = async (
  apiKit: any,
  safeAddress: `0x${string}`,
  targetNonce: number,
  options: { executed?: boolean } = {}
) => {
  if (!Number.isSafeInteger(targetNonce) || targetNonce < 0) {
    throw new Error(
      "Safe transaction nonce must be a non-negative safe integer"
    )
  }
  const executed = options.executed ?? false
  const { results, next } = await apiKit.getMultisigTransactions(safeAddress, {
    executed,
    limit: 2,
    nonce: String(targetNonce),
  })

  const matches = results.filter(
    (transaction: any) =>
      Number(transaction.nonce) === targetNonce &&
      transaction.isExecuted === executed
  )
  if (matches.length === 0) {
    throw new Error(
      `❌ ${executed ? "Executed" : "Pending"} Safe transaction not found for nonce ${targetNonce}. Check the nonce and --executed selection.`
    )
  }
  if (matches.length > 1 || next) {
    throw new Error(
      `❌ Multiple Safe transactions found for nonce ${targetNonce}; cannot select one unambiguously.`
    )
  }
  return matches[0]
}

export const getSafeTxActionsByNonce = async (
  apiKit: any,
  safeAddress: `0x${string}`,
  targetNonce: number,
  options: { executed?: boolean } = {}
): Promise<SafeTransactionAction[]> => {
  const tx = await getSafeTransactionByNonce(
    apiKit,
    safeAddress,
    targetNonce,
    options
  )
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
      // Best-effort decoding is only for the informational decode command.
    }
  }
  return actions
}

const multiSendAbi = parseAbi(["function multiSend(bytes transactions)"])

// The caller must verify the outer envelope against the SDK-built transaction
// first. Select the shape from the local manifest, never from service decoding.
export const decodeSafeTransactionActions = (
  tx: SafeTransactionAction,
  options: { multiSend: boolean }
): SafeTransactionAction[] => {
  try {
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data)) {
      throw new Error("Invalid calldata bytes")
    }
    if (!options.multiSend) {
      return [
        { data: tx.data, operation: tx.operation, to: tx.to, value: tx.value },
      ]
    }

    const { args } = decodeFunctionData({
      abi: multiSendAbi,
      data: tx.data as `0x${string}`,
    })
    if (
      encodeFunctionData({
        abi: multiSendAbi,
        args,
        functionName: "multiSend",
      }).toLowerCase() !== tx.data.toLowerCase()
    ) {
      throw new Error("Non-canonical MultiSend calldata")
    }
    const packed = args[0].slice(2)
    const actions: SafeTransactionAction[] = []
    let offset = 0
    while (offset < packed.length) {
      // Packed header: operation (1), target (20), value (32), data length (32).
      if (packed.length - offset < 85 * 2) {
        throw new Error("Truncated MultiSend action header")
      }
      const operation = Number.parseInt(packed.slice(offset, offset + 2), 16)
      if (operation !== 0 && operation !== 1) {
        throw new Error("Invalid MultiSend operation")
      }
      const to = `0x${packed.slice(offset + 2, offset + 42)}`
      const value = BigInt(
        `0x${packed.slice(offset + 42, offset + 106)}`
      ).toString()
      const dataLength = BigInt(`0x${packed.slice(offset + 106, offset + 170)}`)
      offset += 170
      // Check before converting the untrusted uint256 length to a JS number.
      if (dataLength > BigInt((packed.length - offset) / 2)) {
        throw new Error("Truncated MultiSend action data")
      }
      const end = offset + Number(dataLength) * 2
      actions.push({
        data: `0x${packed.slice(offset, end)}`,
        operation,
        to,
        value,
      })
      offset = end
    }
    return actions
  } catch (error) {
    throw new Error("Unable to decode Safe transaction for verification", {
      cause: error,
    })
  }
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
