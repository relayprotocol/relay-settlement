import { RelayHub } from "@relay-protocol/settlement-abis"
import { Contract, JsonRpcProvider } from "ethers"
import { config } from "../config.js"
import { closeDb, openDb } from "../db/connection.js"
import { runTransferReplay } from "../services/transferReplay.js"

const parseInteger = (
  name: string,
  options: {
    description: string
    fallback?: number
    min: number
  }
) => {
  const value = process.env[name]
  if (!value) {
    if (options.fallback == null) {
      throw new Error(`Missing required env var: ${name}`)
    }
    if (options.fallback < options.min) {
      throw new Error(
        `Invalid ${options.description} for ${name}: ${options.fallback}`
      )
    }
    return options.fallback
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < options.min) {
    throw new Error(`Invalid ${options.description} for ${name}: ${value}`)
  }
  return parsed
}

const parseBlock = (name: string, fallback?: number) =>
  parseInteger(name, {
    description: "block number",
    fallback,
    min: 0,
  })

const parsePositiveInteger = (name: string, fallback?: number) =>
  parseInteger(name, {
    description: "positive integer",
    fallback,
    min: 1,
  })

const main = async () => {
  if (!config.rpcHttpUrl) {
    throw new Error("RPC_HTTP_URL is required for transfer replay")
  }

  const provider = new JsonRpcProvider(config.rpcHttpUrl)
  const latestBlock = await provider.getBlockNumber()
  const fromBlock = parseBlock("TRANSFER_REPLAY_FROM_BLOCK")
  const toBlock = parseBlock("TRANSFER_REPLAY_TO_BLOCK", latestBlock)
  const batchSize = parsePositiveInteger(
    "TRANSFER_REPLAY_BATCH_SIZE",
    config.batchSize
  )
  const reconcileChunkSize = parsePositiveInteger(
    "TRANSFER_REPLAY_RECONCILE_CHUNK",
    100
  )

  if (fromBlock > toBlock) {
    throw new Error(
      `TRANSFER_REPLAY_FROM_BLOCK (${fromBlock}) must be <= TRANSFER_REPLAY_TO_BLOCK (${toBlock})`
    )
  }

  const db = await openDb()
  const hubContract = new Contract(
    config.hubContractAddress,
    RelayHub,
    provider
  )

  try {
    await runTransferReplay(
      db,
      provider,
      hubContract,
      {
        batchSize,
        fromBlock,
        reconcileChunkSize,
        toBlock,
      },
      {
        onProgress: (progress) => {
          console.info(JSON.stringify(progress))
        },
      }
    )
  } finally {
    await closeDb()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
