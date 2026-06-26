import { spawnSync } from "node:child_process"
import { config as dotEnvConfig } from "dotenv"
import { getDatabaseUrlWithPassword } from "../db/connection.js"

dotEnvConfig()
;(async () => {
  process.env.DATABASE_URL = await getDatabaseUrlWithPassword(
    process.env.DATABASE_URL
  )

  const result = spawnSync("node-pg-migrate", process.argv.slice(2), {
    stdio: "inherit",
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(
      `node-pg-migrate exited with status ${result.status ?? "unknown"}`
    )
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
