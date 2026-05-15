import { RelayHub } from "@relay-protocol/settlement-abis"
import { Contract, JsonRpcProvider } from "ethers"
import { config } from "../config.js"
import { closeDb, openDb } from "../db/connection.js"

type BalanceRow = {
  address: string
  balance: string
  token_id: string
}

type BalanceMismatch = {
  address: string
  chainBalance: string
  indexedBalance: string
  tokenId: string
}

const parsePositiveInteger = (name: string, fallback: number) => {
  const value = process.env[name]
  if (!value) return fallback

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${value}`)
  }
  return parsed
}

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

const main = async () => {
  if (!config.rpcHttpUrl) {
    throw new Error("RPC_HTTP_URL is required for balance audit")
  }

  const tokenLimit = parsePositiveInteger("BALANCE_AUDIT_TOKEN_LIMIT", 20)
  const holderLimit = parsePositiveInteger("BALANCE_AUDIT_HOLDER_LIMIT", 20)
  const batchSize = parsePositiveInteger("BALANCE_AUDIT_BATCH_SIZE", 20)
  const tokenId = process.env.BALANCE_AUDIT_TOKEN_ID
  const address = process.env.BALANCE_AUDIT_ADDRESS?.toLowerCase()

  if (address && !tokenId) {
    throw new Error(
      "BALANCE_AUDIT_TOKEN_ID is required with BALANCE_AUDIT_ADDRESS"
    )
  }

  const db = await openDb()
  const provider = new JsonRpcProvider(config.rpcHttpUrl)
  const hubContract = new Contract(
    config.hubContractAddress,
    RelayHub,
    provider
  )

  try {
    const rows = address
      ? await db.manyOrNone<BalanceRow>(
          `SELECT $1 AS address, $2 AS token_id, COALESCE(balance, 0)::text AS balance
           FROM (VALUES (1)) AS seed(_)
           LEFT JOIN balances ON balances.address = $1 AND balances.token_id = $2`,
          [address, tokenId]
        )
      : await db.manyOrNone<BalanceRow>(
          `WITH selected_tokens AS (
             SELECT token_id
             FROM tokens
             WHERE ($1::text IS NULL OR token_id = $1)
             ORDER BY transfers DESC, token_id ASC
             LIMIT $2
           )
           SELECT b.address, b.token_id, b.balance::text AS balance
           FROM selected_tokens t
           JOIN LATERAL (
             SELECT address, token_id, balance
             FROM balances
             WHERE token_id = t.token_id AND balance > 0
             ORDER BY balance DESC, address ASC
             LIMIT $3
           ) b ON true`,
          [tokenId ?? null, tokenLimit, holderLimit]
        )

    const mismatches: BalanceMismatch[] = []

    for (const batch of chunk(rows, batchSize)) {
      const checked = await Promise.all(
        batch.map(async (row) => {
          const chainBalance = BigInt(
            (await hubContract.balanceOf(row.address, row.token_id)).toString()
          ).toString()

          return {
            ...row,
            chainBalance,
          }
        })
      )

      for (const row of checked) {
        if (row.balance !== row.chainBalance) {
          mismatches.push({
            address: row.address,
            chainBalance: row.chainBalance,
            indexedBalance: row.balance,
            tokenId: row.token_id,
          })
        }
      }
    }

    console.info(
      JSON.stringify(
        {
          checked: rows.length,
          mismatches,
          ok: mismatches.length === 0,
        },
        null,
        2
      )
    )

    if (mismatches.length > 0) {
      process.exitCode = 1
    }
  } finally {
    await closeDb()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
