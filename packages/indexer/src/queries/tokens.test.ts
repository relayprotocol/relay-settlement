import assert from "node:assert/strict"
import test from "node:test"
import type { Database } from "../db/connection.js"
import { listTokenBalances } from "./tokens.js"

test("listTokenBalances applies numeric balance cursors", async () => {
  let capturedParams: Record<string, string | number> | undefined

  const db = {
    manyOrNone: async <T>(
      _query: string,
      params: Record<string, string | number>
    ) => {
      capturedParams = params
      return [] as T[]
    },
  } as unknown as Database

  await listTokenBalances(
    db,
    "relay-token-1",
    20,
    "123:0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
  )

  assert.deepEqual(capturedParams, {
    cursorAddress: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
    cursorBalance: "123",
    limit: 20,
    tokenId: "relay-token-1",
  })
})
