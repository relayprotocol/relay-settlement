export const MAX_PROTOCOL_TRANSACTION_BATCH_SIZE = 200

export class ProtocolTransactionRequestError extends Error {}

export const normalizeProtocolTransactionHashes = (
  txHashes: unknown,
  maxBatchSize = MAX_PROTOCOL_TRANSACTION_BATCH_SIZE
) => {
  if (!Array.isArray(txHashes)) {
    throw new ProtocolTransactionRequestError("txHashes must be an array")
  }

  if (txHashes.some((value) => typeof value !== "string")) {
    throw new ProtocolTransactionRequestError(
      "txHashes must contain only strings"
    )
  }

  const normalizedTxHashes = Array.from(
    new Set(txHashes.map((value) => value.toLowerCase()))
  )

  if (!normalizedTxHashes.length) {
    throw new ProtocolTransactionRequestError("txHashes must not be empty")
  }

  if (normalizedTxHashes.length > maxBatchSize) {
    throw new ProtocolTransactionRequestError(
      `txHashes must contain at most ${maxBatchSize} entries`
    )
  }

  return normalizedTxHashes
}
