import assert from "node:assert/strict"
import test from "node:test"
import { parseDatabaseUrl } from "./connection.js"

test("parseDatabaseUrl decodes encoded credentials", () => {
  const parsed = parseDatabaseUrl(
    "postgresql://user%40relay:p%40ss%3Aword%2F123@127.0.0.1:5432/indexer"
  )

  assert.deepEqual(parsed, {
    database: "indexer",
    host: "127.0.0.1",
    password: "p@ss:word/123",
    port: 5432,
    user: "user@relay",
  })
})
