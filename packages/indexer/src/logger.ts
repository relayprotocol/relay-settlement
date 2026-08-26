type LogLevel = "debug" | "error" | "info" | "warn"

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  error: 40,
  info: 20,
  warn: 30,
}

const configuredLevel = process.env.LOG_LEVEL?.toLowerCase()
const minimumLevel: LogLevel =
  configuredLevel && configuredLevel in levelPriority
    ? (configuredLevel as LogLevel)
    : "info"

const serialize = (data: Record<string, unknown> | undefined) => {
  if (!data) {
    return ""
  }

  return Object.entries(data)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")
}

const writeLog = (level: LogLevel, output: string) => {
  if (level === "error") {
    console.error(output)
    return
  }

  if (level === "warn") {
    console.warn(output)
    return
  }

  if (level === "debug") {
    console.debug(output)
    return
  }

  console.info(output)
}

const shouldLog = (level: LogLevel) =>
  levelPriority[level] >= levelPriority[minimumLevel]

const log = (
  level: LogLevel,
  scope: string,
  message: string,
  data?: Record<string, unknown>
) => {
  if (!shouldLog(level)) {
    return
  }

  const suffix = serialize(data)
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`
  writeLog(level, suffix ? `${line} ${suffix}` : line)
}

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    }
  }
  return typeof value === "bigint" ? value.toString() : value
}

const logJson = (
  level: LogLevel,
  scope: string,
  message: string,
  data?: Record<string, unknown>
) => {
  if (!shouldLog(level)) {
    return
  }

  writeLog(
    level,
    JSON.stringify(
      {
        ...data,
        level,
        message,
        scope,
        status: level,
        timestamp: new Date().toISOString(),
      },
      jsonReplacer
    )
  )
}

export const logger = {
  debug: (scope: string, message: string, data?: Record<string, unknown>) =>
    log("debug", scope, message, data),
  error: (scope: string, message: string, data?: Record<string, unknown>) =>
    log("error", scope, message, data),
  info: (scope: string, message: string, data?: Record<string, unknown>) =>
    log("info", scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) =>
    log("warn", scope, message, data),
}

export const jsonLogger = {
  debug: (scope: string, message: string, data?: Record<string, unknown>) =>
    logJson("debug", scope, message, data),
  error: (scope: string, message: string, data?: Record<string, unknown>) =>
    logJson("error", scope, message, data),
  info: (scope: string, message: string, data?: Record<string, unknown>) =>
    logJson("info", scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) =>
    logJson("warn", scope, message, data),
}
