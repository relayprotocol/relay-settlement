import dotenv from "dotenv"

dotenv.config()

export type RuntimeConfig = {
  allowUnauthenticatedApi: boolean
  authApiKey: string | undefined
  doBackgroundWork: boolean
  enableApi: boolean
  port: number
}

export const resolvePort = (value: string | undefined) => {
  if (!value) {
    return 3001
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 3001
}

export const resolveBoolean = (
  value: string | undefined,
  fallback: boolean
) => {
  if (!value) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()

  if (normalized === "1" || normalized === "true") {
    return true
  }

  if (normalized === "0" || normalized === "false") {
    return false
  }

  throw new Error(`Invalid boolean env value: ${value}`)
}

export const validateRuntimeConfig = (config: RuntimeConfig) => {
  if (
    config.enableApi &&
    !config.authApiKey &&
    !config.allowUnauthenticatedApi
  ) {
    throw new Error(
      "AUTH_API_KEY is required when ENABLE_API=1 unless ALLOW_UNAUTHENTICATED_API=1"
    )
  }
}

export const config: RuntimeConfig = {
  allowUnauthenticatedApi: resolveBoolean(
    process.env.ALLOW_UNAUTHENTICATED_API,
    false
  ),
  authApiKey: process.env.AUTH_API_KEY,
  doBackgroundWork: resolveBoolean(process.env.DO_BACKGROUND_WORK, true),
  enableApi: resolveBoolean(process.env.ENABLE_API, true),
  port: resolvePort(process.env.PORT),
}
