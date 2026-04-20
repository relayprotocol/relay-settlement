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

export const createApiKeyMiddleware = (expectedApiKey: string | undefined) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/")) {
      return next()
    }

    if (isApiKeyAuthorized(req.headers["x-api-key"], expectedApiKey)) {
      return next()
    }

    return res.status(401).json({
      error: "Unauthorized",
    })
  }
}
