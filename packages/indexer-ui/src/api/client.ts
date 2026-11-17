import createClient from "openapi-fetch"
import { onlineManager } from "@tanstack/react-query"
import type { paths, ServerErrorResponse } from "./schema"

export const api = createClient<paths>({ baseUrl: "/api/v1" })

export class ApiError extends Error {
  readonly status: number
  readonly detail?: string

  constructor(status: number, message: string, detail?: string) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

export class ConnectionError extends Error {
  constructor(cause?: unknown) {
    super("Cannot reach the indexer API", { cause })
  }
}

const GATEWAY_STATUSES = new Set([502, 503, 504])

const isServerError = (error: unknown): error is ServerErrorResponse =>
  typeof error === "object" && error !== null && "message" in error

export const unwrap = async <T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>
) => {
  const { data, error, response } = await request.catch((cause: unknown) => {
    throw new ConnectionError(cause)
  })
  if (error === undefined && data !== undefined) return data
  if (GATEWAY_STATUSES.has(response.status) && !isServerError(error))
    throw new ConnectionError()
  const path = response.url ? new URL(response.url).pathname : "Request"
  const detail = isServerError(error) ? error.message : response.statusText
  throw new ApiError(
    response.status,
    `${path} returned ${response.status}${detail ? `: ${detail}` : ""}`,
    detail
  )
}

export const shouldRetry = (failureCount: number, error: Error) =>
  failureCount < 3 &&
  onlineManager.isOnline() &&
  !(error instanceof ApiError && error.status < 500)
