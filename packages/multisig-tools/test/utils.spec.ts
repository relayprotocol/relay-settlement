import { readdirSync, readFileSync } from "fs"
import { join } from "path"
import { describe, expect, it } from "vitest"
import { TransactionsSchema } from "../src/builders/utils"

const TRANSACTIONS_DIR = join(__dirname, "..", "transactions")

// Some historical manifests contain redacted placeholder RPCs that never
// parsed as URLs. Exclude those so the schema parity test only covers
// real-world manifests.
const hasUnparseableRpcPlaceholder = (raw: string) => raw.includes("[REDACTED")

const manifestFiles = readdirSync(TRANSACTIONS_DIR)
  .filter((name) => name.endsWith(".json"))
  .filter((name) => {
    const raw = readFileSync(join(TRANSACTIONS_DIR, name), "utf8")
    return !hasUnparseableRpcPlaceholder(raw)
  })
  .sort()

describe("TransactionsSchema parses every committed manifest", () => {
  it.each(manifestFiles)("parses %s", (name) => {
    const raw = readFileSync(join(TRANSACTIONS_DIR, name), "utf8")
    const data = JSON.parse(raw)
    const result = TransactionsSchema.safeParse(data)
    if (!result.success) {
      throw new Error(
        `Manifest ${name} failed schema validation:\n${JSON.stringify(result.error.issues, null, 2)}`
      )
    }
    expect(result.success).toBe(true)
  })
})
