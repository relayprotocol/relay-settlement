import "dotenv/config"
import { closeDb, openDb } from "../db/connection.js"
import { syncTokenTransfersFromEvents } from "../services/transferProcessor.js"

const main = async () => {
  const tokenId = process.env.TRANSFER_COUNT_TOKEN_ID
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    throw new Error("TRANSFER_COUNT_TOKEN_ID must be a decimal token ID")
  }
  const db = await openDb()
  try {
    await syncTokenTransfersFromEvents(db, BigInt(tokenId).toString())
    console.info("Transfer count repaired", { tokenId })
  } finally {
    await closeDb()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
