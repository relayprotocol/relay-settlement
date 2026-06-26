import { timingSafeEqual } from "node:crypto"
import type { NextFunction, Request, Response } from "express"

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left, "utf8")
  const rightBuffer = Buffer.from(right, "utf8")

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

export const isApiKeyAuthorized = (
  providedApiKey: string | string[] | undefined,
  expectedApiKey: string | undefined
) => {
  if (!expectedApiKey) {
    return true
  }

  if (Array.isArray(providedApiKey)) {
    return providedApiKey.some((value) => safeEqual(value, expectedApiKey))
  }

  if (typeof providedApiKey !== "string") {
    return false
  }

  return safeEqual(providedApiKey, expectedApiKey)
}

export const createApiKeyMiddleware = (
  expectedApiKey: string | undefined,
  options: {
    headerName?: string
    pathPrefix?: string
  } = {}
) => {
  const headerName = options.headerName ?? "x-api-key"
  const pathPrefix = options.pathPrefix ?? "/api/"

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith(pathPrefix)) {
      return next()
    }

    if (isApiKeyAuthorized(req.headers[headerName], expectedApiKey)) {
      return next()
    }

    return res.status(401).json({
      error: "Unauthorized",
    })
  }
}
