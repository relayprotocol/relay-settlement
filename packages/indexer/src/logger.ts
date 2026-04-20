const serialize = (data: Record<string, unknown> | undefined) => {
  if (!data) {
    return ""
  }

  return Object.entries(data)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")
}

const log = (
  level: "error" | "info" | "warn",
  scope: string,
  message: string,
  data?: Record<string, unknown>
) => {
  const suffix = serialize(data)
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`
  const output = suffix ? `${line} ${suffix}` : line

  if (level === "error") {
    console.error(output)
    return
  }

  if (level === "warn") {
    console.warn(output)
    return
  }

  console.info(output)
}

export const logger = {
  error: (scope: string, message: string, data?: Record<string, unknown>) =>
    log("error", scope, message, data),
  info: (scope: string, message: string, data?: Record<string, unknown>) =>
    log("info", scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) =>
    log("warn", scope, message, data),
}
