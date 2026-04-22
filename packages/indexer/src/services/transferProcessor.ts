import { RelayHub } from "@relay-protocol/settlement-abis"
import { Contract } from "ethers"
import { Interface } from "ethers"
import type { Database, Queryable } from "../db/connection.js"
import { runWithRetry } from "./retry.js"
import {
  getProtocolTransferType,
  isZeroAddress,
} from "../protocol/transferSemantics.js"
import { logger } from "../logger.js"
import {
  applyRoleEvent,
  insertRoleEvent,
  parseAccessControlLog,
} from "./accessControlProcessor.js"

const erc6909TransferWithCaller = new Interface(RelayHub)

const SKIP_TOKEN_IDS = new Set<string>([
  "645919125454048919867832098713637349341491234231283657783660937934976435626",
])

export const shouldSkipTokenId = (tokenId: string) =>
  SKIP_TOKEN_IDS.has(tokenId)

const toBigInt = (value: string | bigint) => BigInt(value)

type TokenMetadataRow = {
  token_id: string
  name: string | null
  symbol: string | null
  decimals: number | null
  total_supply: string
  holders: number
}

const selectToken = async (db: Queryable, tokenId: string) =>
  db.oneOrNone<TokenMetadataRow>(
    `SELECT token_id, name, symbol, decimals, total_supply, holders
     FROM tokens
     WHERE token_id = $1`,
    [tokenId]
  )

export const ensureToken = async (
  db: Queryable,
  contract: Contract,
  tokenId: string
) => {
  const existing = await selectToken(db, tokenId)
  if (existing) {
    return existing
  }

  let name: string | null = null
  let symbol: string | null = null
  let decimals: number | null = null

  try {
    name = await contract.name(tokenId)
  } catch {
    name = null
  }

  try {
    symbol = await contract.symbol(tokenId)
  } catch {
    symbol = null
  }

  try {
    decimals = Number(await contract.decimals(tokenId))
  } catch {
    decimals = null
  }

  const now = new Date().toISOString()
  const resolvedName = name ?? "Unknown"
  await db.none(
    `INSERT INTO tokens(token_id, name, symbol, decimals, total_supply, holders, transfers, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(token_id) DO NOTHING`,
    [tokenId, resolvedName, symbol, decimals, "0", 0, 0, now, now]
  )

  return (
    (await selectToken(db, tokenId)) ?? {
      decimals,
      holders: 0,
      name: resolvedName,
      symbol,
      token_id: tokenId,
      total_supply: "0",
    }
  )
}

export const refreshTokenMetadata = async (
  db: Queryable,
  contract: Contract,
  tokenId: string
) => {
  const [nameResult, symbolResult, decimalsResult] = await Promise.allSettled([
    contract.name(tokenId),
    contract.symbol(tokenId),
    contract.decimals(tokenId),
  ])

  const name =
    nameResult.status === "fulfilled" ? (nameResult.value as string) : null
  const symbol =
    symbolResult.status === "fulfilled" ? (symbolResult.value as string) : null
  const decimals =
    decimalsResult.status === "fulfilled" ? Number(decimalsResult.value) : null

  const now = new Date().toISOString()
  const resolvedName = name ?? "Unknown"
  await db.none(
    "UPDATE tokens SET name = $1, symbol = $2, decimals = $3, updated_at = $4 WHERE token_id = $5",
    [resolvedName, symbol, decimals, now, tokenId]
  )

  return { decimals, name: resolvedName, symbol, token_id: tokenId }
}

export const refreshAddressBalances = async (
  db: Database,
  contract: Contract,
  address: string
) => {
  const wallet = address.toLowerCase()
  const tokens = await db.manyOrNone<{
    token_id: string
    decimals: number | null
  }>("SELECT token_id, decimals FROM tokens")

  const eligibleTokens = tokens.filter((t) => !shouldSkipTokenId(t.token_id))
  const batchSize = 5
  const chainBalances: Array<{
    tokenId: string
    decimals: number | null
    totalSupply: bigint | null
    balance: bigint
  }> = []

  for (let i = 0; i < eligibleTokens.length; i += batchSize) {
    const batch = eligibleTokens.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async (token) => {
        const [balanceResult, totalSupplyResult] = await Promise.allSettled([
          contract.balanceOf(wallet, token.token_id),
          contract.totalSupply(token.token_id),
        ])
        if (balanceResult.status !== "fulfilled") {
          return null
        }

        chainBalances.push({
          balance: BigInt(balanceResult.value.toString()),
          decimals: token.decimals,
          tokenId: token.token_id,
          totalSupply:
            totalSupplyResult.status === "fulfilled"
              ? BigInt(totalSupplyResult.value.toString())
              : null,
        })
        return null
      })
    )
  }

  let updated = 0
  await runWithRetry(async () => {
    await db.tx(async (tx) => {
      const now = new Date().toISOString()
      for (const item of chainBalances) {
        const previous = await getBalance(tx, wallet, item.tokenId)
        if (previous === item.balance && item.totalSupply == null) continue

        const holderDelta =
          previous === 0n && item.balance > 0n
            ? 1
            : previous > 0n && item.balance === 0n
              ? -1
              : 0

        if (previous !== item.balance) {
          await setBalance(
            tx,
            wallet,
            item.tokenId,
            item.balance,
            item.decimals
          )
        }

        if (item.totalSupply != null) {
          await tx.none(
            "UPDATE tokens SET total_supply = $1, holders = holders + $2, updated_at = $3 WHERE token_id = $4",
            [item.totalSupply.toString(), holderDelta, now, item.tokenId]
          )
        } else if (holderDelta !== 0) {
          await tx.none(
            "UPDATE tokens SET holders = holders + $1, updated_at = $2 WHERE token_id = $3",
            [holderDelta, now, item.tokenId]
          )
        }
        updated += 1
      }
    })
  })

  return { address: wallet, refreshed: chainBalances.length, updated }
}

const getBalance = async (db: Queryable, address: string, tokenId: string) => {
  const row = await db.oneOrNone<{ balance: string }>(
    "SELECT balance FROM balances WHERE address = $1 AND token_id = $2",
    [address, tokenId]
  )
  return row ? BigInt(row.balance) : 0n
}

const setBalance = async (
  db: Queryable,
  address: string,
  tokenId: string,
  balance: bigint,
  decimals: number | null,
  timestamp?: number
) => {
  if (balance <= 0n) {
    await db.none("DELETE FROM balances WHERE address = $1 AND token_id = $2", [
      address,
      tokenId,
    ])
    return
  }

  const now = new Date().toISOString()
  const scaled = (() => {
    if (decimals == null || !Number.isFinite(decimals)) return null
    const divisor = 10n ** BigInt(decimals)
    const whole = balance / divisor
    const fraction = balance % divisor
    if (whole > BigInt(Number.MAX_SAFE_INTEGER)) return null
    const base = Number(whole)
    const frac = Number(fraction) / Number(divisor)
    return base + frac
  })()

  await db.none(
    `INSERT INTO balances(address, token_id, balance, balance_scaled, last_transfer_at, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(address, token_id) DO UPDATE SET
       balance = EXCLUDED.balance,
       balance_scaled = EXCLUDED.balance_scaled,
       last_transfer_at = CASE
         WHEN EXCLUDED.last_transfer_at IS NOT NULL AND (
           balances.last_transfer_at IS NULL OR EXCLUDED.last_transfer_at > balances.last_transfer_at
         ) THEN EXCLUDED.last_transfer_at
         ELSE balances.last_transfer_at
       END,
       updated_at = EXCLUDED.updated_at`,
    [address, tokenId, balance.toString(), scaled, timestamp ?? null, now, now]
  )
}

const updateTokenTotals = async (
  db: Queryable,
  tokenId: string,
  totalSupply: bigint,
  holderDelta: number
) => {
  const now = new Date().toISOString()
  await db.none(
    "UPDATE tokens SET total_supply = $1, holders = holders + $2, updated_at = $3 WHERE token_id = $4",
    [totalSupply.toString(), holderDelta, now, tokenId]
  )
}

const setTokenState = async (
  db: Queryable,
  tokenId: string,
  totalSupply: bigint,
  holders: number
) => {
  const now = new Date().toISOString()
  await db.none(
    "UPDATE tokens SET total_supply = $1, holders = $2, updated_at = $3 WHERE token_id = $4",
    [totalSupply.toString(), holders, now, tokenId]
  )
}

const getHolderCount = async (db: Queryable, tokenId: string) => {
  const row = await db.one<{ count: number | string }>(
    "SELECT COUNT(*)::int AS count FROM balances WHERE token_id = $1",
    [tokenId]
  )

  return Number(row.count)
}

const getTotalSupply = async (
  contract: Contract,
  tokenId: string
): Promise<bigint> => {
  const totalSupply = await contract.totalSupply(tokenId)
  return BigInt(totalSupply.toString())
}

export const incrementTokenTransfers = async (
  db: Queryable,
  tokenId: string
) => {
  await db.none(
    "UPDATE tokens SET transfers = transfers + 1 WHERE token_id = $1",
    [tokenId]
  )
}

export const reconcileTransferStateFromChain = async (
  db: Queryable,
  contract: Contract,
  tokenId: string,
  addresses: string[],
  timestamp?: number
) => {
  const token = await ensureToken(db, contract, tokenId)
  const trackedAddresses = [
    ...new Set(addresses.map((a) => a.toLowerCase())),
  ].filter((address) => !isZeroAddress(address))

  const balances = await Promise.all(
    trackedAddresses.map(async (address) => ({
      address,
      balance: BigInt((await contract.balanceOf(address, tokenId)).toString()),
    }))
  )

  for (const item of balances) {
    const previous = await getBalance(db, item.address, tokenId)
    if (previous === item.balance) continue
    await setBalance(
      db,
      item.address,
      tokenId,
      item.balance,
      token.decimals,
      timestamp
    )
  }

  const [totalSupply, holders] = await Promise.all([
    getTotalSupply(contract, tokenId),
    getHolderCount(db, tokenId),
  ])
  await setTokenState(db, tokenId, totalSupply, holders)
}

export const applyTransfer = async (
  db: Queryable,
  contract: Contract,
  tokenId: string,
  from: string,
  to: string,
  amount: bigint,
  timestamp?: number
) => {
  const token = await ensureToken(db, contract, tokenId)
  let holdersDelta = 0
  let totalSupply = toBigInt(token.total_supply)

  const fromAddr = from.toLowerCase()
  const toAddr = to.toLowerCase()

  if (isZeroAddress(fromAddr)) {
    totalSupply += amount
  } else {
    const fromOld = await getBalance(db, fromAddr, tokenId)
    const fromNew = fromOld - amount
    if (fromOld > 0n && fromNew <= 0n) {
      holdersDelta -= 1
    }
    await setBalance(db, fromAddr, tokenId, fromNew, token.decimals, timestamp)
  }

  if (isZeroAddress(toAddr)) {
    totalSupply -= amount
  } else {
    const toOld = await getBalance(db, toAddr, tokenId)
    const toNew = toOld + amount
    if (toOld === 0n && toNew > 0n) {
      holdersDelta += 1
    }
    await setBalance(db, toAddr, tokenId, toNew, token.decimals, timestamp)
  }

  await updateTokenTotals(db, tokenId, totalSupply, holdersDelta)
}

export const insertEvent = async (
  db: Queryable,
  log: {
    blockNumber: number
    transactionHash: string
    index: number
    operator: string
    from: string
    to: string
    tokenId: string
    amount: string
    timestamp: number
  }
) => {
  const now = new Date().toISOString()
  const inserted = await db.result(
    `INSERT INTO events(
      block_number, tx_hash, log_index, operator, from_addr, to_addr, token_id, amount, timestamp, created_at, updated_at
    ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT(tx_hash, log_index) DO NOTHING
     RETURNING 1`,
    [
      log.blockNumber,
      log.transactionHash,
      log.index,
      log.operator.toLowerCase(),
      log.from.toLowerCase(),
      log.to.toLowerCase(),
      log.tokenId,
      log.amount,
      log.timestamp,
      now,
      now,
    ],
    (result) => result.rowCount
  )
  return inserted
}

export const parseTransferLog = (log: {
  topics: readonly string[]
  data: string
}) => {
  try {
    return erc6909TransferWithCaller.parseLog(log)
  } catch {
    return null
  }
}

export const recordFailedEvent = async (
  db: Queryable,
  contractAddress: string,
  log: {
    blockNumber: number
    transactionHash: string
    index: number
    topics: readonly string[]
    data: string
  },
  error: unknown
) => {
  const now = new Date().toISOString()
  await db.none(
    `INSERT INTO failed_events(
      contract_address, block_number, tx_hash, log_index, data, error, retry_count, created_at, updated_at
    ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(contract_address, block_number, log_index, tx_hash)
     DO UPDATE SET error = EXCLUDED.error, retry_count = failed_events.retry_count + 1, updated_at = EXCLUDED.updated_at`,
    [
      contractAddress.toLowerCase(),
      log.blockNumber,
      log.transactionHash,
      log.index,
      JSON.stringify({ data: log.data, topics: log.topics }),
      String(error),
      0,
      now,
      now,
    ]
  )
}

export const processSingleLog = async (
  db: Database,
  context: LogProcessingContext,
  log: {
    blockNumber: number
    transactionHash: string
    index: number
    topics: readonly string[]
    data: string
  },
  timestamp: number
) => {
  await runWithRetry(async () => {
    await db.tx(async (tx) => {
      const parsedTransfer = parseTransferLog(log)
      const parsedAccess = parsedTransfer ? null : parseAccessControlLog(log)
      if (!parsedTransfer && !parsedAccess) {
        logger.warn("processor", "Skipping undecodable log", {
          blockNumber: log.blockNumber,
          logIndex: log.index,
          txHash: log.transactionHash,
        })
        return
      }

      if (parsedTransfer) {
        if (!context.tokenContract) {
          throw new Error("Transfer log processing requires a token contract")
        }
        const operator = parsedTransfer.args.caller
        const from = parsedTransfer.args.from
        const to = parsedTransfer.args.to
        const id = parsedTransfer.args.id
        const amount = parsedTransfer.args.amount

        if (shouldSkipTokenId(id.toString())) {
          logger.info("processor", "Skipping transfer for token", {
            blockNumber: log.blockNumber,
            logIndex: log.index,
            tokenId: id.toString(),
            txHash: log.transactionHash,
          })
          return
        }

        const inserted = await insertEvent(tx, {
          amount: amount.toString(),
          blockNumber: log.blockNumber,
          from,
          index: log.index,
          operator,
          timestamp,
          to,
          tokenId: id.toString(),
          transactionHash: log.transactionHash,
        })

        if (inserted) {
          await applyTransfer(
            tx,
            context.tokenContract,
            id.toString(),
            from,
            to,
            amount,
            timestamp
          )
          await incrementTokenTransfers(tx, id.toString())
        }

        if (inserted) {
          logger.info("processor", "Transfer processed", {
            amount: amount.toString(),
            blockNumber: log.blockNumber,
            from,
            logIndex: log.index,
            operator,
            to,
            tokenId: id.toString(),
            txHash: log.transactionHash,
            type: getProtocolTransferType(from, to),
          })
        }
        return
      }

      if (parsedAccess) {
        const inserted = await insertRoleEvent(
          tx,
          {
            blockNumber: log.blockNumber,
            contractAddress: context.contractAddress,
            index: log.index,
            timestamp,
            transactionHash: log.transactionHash,
          },
          parsedAccess
        )

        if (inserted) {
          await applyRoleEvent(tx, context.contractAddress, parsedAccess)
        }

        if (inserted) {
          logger.info("processor", "Access control event processed", {
            account: parsedAccess.account,
            blockNumber: log.blockNumber,
            eventType: parsedAccess.eventType,
            logIndex: log.index,
            role: parsedAccess.role,
            sender: parsedAccess.sender,
            txHash: log.transactionHash,
          })
        }
      }
    })
  })
}

type LogProcessingContext = {
  contractAddress: string
  tokenContract?: Contract
}
