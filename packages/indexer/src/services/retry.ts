const RETRY_MAX = 5
const RETRYABLE_PG_ERROR_CODES = new Set(["40001", "40P01", "55P03"])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isRetryablePgError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return false
  }

  const candidate = error as { code?: string; message?: string }
  const code = candidate.code
  const message = candidate.message?.toLowerCase() ?? ""

  return (
    (typeof code === "string" && RETRYABLE_PG_ERROR_CODES.has(code)) ||
    message.includes("could not serialize access") ||
    message.includes("deadlock detected") ||
    message.includes("lock not available")
  )
}

export const runWithRetry = async <T>(fn: () => Promise<T>) => {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error) {
      if (!isRetryablePgError(error) || attempt >= RETRY_MAX) {
        throw error
      }
      const delay = 200 * 2 ** attempt
      await sleep(delay)
      attempt += 1
    }
  }
}
