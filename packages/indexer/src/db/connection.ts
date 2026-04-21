import PgPromise from "pg-promise"
import { URL } from "node:url"
import type { IDatabase, ITask } from "pg-promise"
import { getIamToken } from "./aws.js"

export type Database = IDatabase<unknown>
export type Queryable = Database | ITask<unknown>

export const pgp = PgPromise()

pgp.pg.types.setTypeParser(20, (value) => parseInt(value, 10))

type DatabaseUrlParts = {
  host: string
  port: number
  user: string
  password: string
  database: string
}

const defaultPgOptions = {
  connectionTimeoutMillis: 10 * 1000,
  keepAlive: true,
  max: 10,
  query_timeout: 10 * 1000,
}

const decodeUrlComponent = (value: string) =>
  value ? decodeURIComponent(value) : value

export const parseDatabaseUrl = (url: string): DatabaseUrlParts => {
  const parsed = new URL(url)

  return {
    database: parsed.pathname.replace(/^\//, ""),
    host: parsed.hostname,
    password: decodeUrlComponent(parsed.password),
    port: Number(parsed.port || 5432),
    user: decodeUrlComponent(parsed.username),
  }
}

const TOKEN_CACHE_TTL_MS = 10 * 60 * 1000

const databaseUrlPgOptions = (url: string) => {
  let cachedToken: string | null = null
  let cachedAt = 0

  const databaseUrl = parseDatabaseUrl(url)

  return {
    database: databaseUrl.database,
    host: databaseUrl.host,
    password: async () => {
      const now = Date.now()

      if (cachedToken && now - cachedAt < TOKEN_CACHE_TTL_MS) {
        return cachedToken
      }

      cachedToken = databaseUrl.password
        ? databaseUrl.password
        : await getIamToken({
            host: databaseUrl.host,
            port: databaseUrl.port,
            region: process.env.AWS_REGION,
            user: databaseUrl.user,
          })
      cachedAt = now

      return cachedToken
    },
    port: databaseUrl.port,
    user: databaseUrl.user,
  }
}

export const getDatabaseUrlWithPassword = async (url: string | undefined) => {
  if (!url) {
    return url
  }

  const parsed = new URL(url)
  if (parsed.password) {
    return url
  }

  const token = await getIamToken({
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    region: process.env.AWS_REGION,
    user: parsed.username,
  })

  parsed.password = encodeURIComponent(token)
  return parsed.toString()
}

let instance: Database | null = null

export const openDb = async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("Missing required env var: DATABASE_URL")
  }

  if (!instance) {
    instance = pgp({
      ...databaseUrlPgOptions(databaseUrl),
      ...defaultPgOptions,
      allowExitOnIdle: true,
      statement_timeout: 10 * 1000,
    })
  }

  await instance.one("SELECT 1 AS ok")
  return instance
}

export const closeDb = async () => {
  pgp.end()
  instance = null
}
