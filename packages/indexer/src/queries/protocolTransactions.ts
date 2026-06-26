import type { Database } from "../db/connection.js"
import type { EventRow, OracleExecutionRow } from "../models/db.js"
import {
  deriveRelayOperation,
  getProtocolTransferType,
  type ProtocolTransferType,
  type RelayOperation,
} from "../protocol/transferSemantics.js"

export type ProtocolTokenMetadata = {
  decimals: number | null
  name: string | null
  symbol: string | null
}

type ProtocolTransferRow = EventRow & {
  token_decimals?: number | null
  token_name?: string | null
  token_symbol?: string | null
}

export type ProtocolTransfer = {
  amount: string
  from: string
  logIndex: number
  operator: string
  to: string
  tokenId: string
  tokenMetadata: ProtocolTokenMetadata
  type: ProtocolTransferType
}

export type ProtocolOracleExecution = {
  actions: string[]
  aggregatedSignature?: string
  idempotencyKey: string
  logIndex: number
  oracleContractAddress: string
  submittedOracleAddress?: string
}

export type ProtocolTransaction = {
  blockNumber: number
  oracleExecutions: ProtocolOracleExecution[]
  relayOperation: RelayOperation
  timestamp: string
  transfers: ProtocolTransfer[]
  txHash: string
}

const parseActions = (
  actionsJson: string,
  txHash: string,
  logIndex: number
) => {
  const parsed = JSON.parse(actionsJson)
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string")
  ) {
    throw new Error(
      `Invalid oracle actions_json for tx ${txHash} logIndex ${logIndex}`
    )
  }
  return parsed
}

const sortByLogIndex = <T extends { logIndex: number }>(rows: T[]) =>
  rows.sort((left, right) => left.logIndex - right.logIndex)

export const projectProtocolTransactions = ({
  oracleRows,
  transferRows,
  txHashes,
}: {
  oracleRows: OracleExecutionRow[]
  transferRows: ProtocolTransferRow[]
  txHashes: string[]
}): ProtocolTransaction[] => {
  const transfersByTxHash = new Map<string, ProtocolTransfer[]>()
  const transferMetaByTxHash = new Map<
    string,
    { blockNumber: number; timestamp: number }
  >()

  for (const row of transferRows) {
    const transfers = transfersByTxHash.get(row.tx_hash) ?? []
    transfers.push({
      amount: row.amount,
      from: row.from_addr,
      logIndex: row.log_index,
      operator: row.operator,
      to: row.to_addr,
      tokenId: row.token_id,
      tokenMetadata: {
        decimals: row.token_decimals ?? null,
        name: row.token_name ?? null,
        symbol: row.token_symbol ?? null,
      },
      type: getProtocolTransferType(row.from_addr, row.to_addr),
    })
    transfersByTxHash.set(row.tx_hash, transfers)

    if (!transferMetaByTxHash.has(row.tx_hash)) {
      transferMetaByTxHash.set(row.tx_hash, {
        blockNumber: row.block_number,
        timestamp: row.timestamp,
      })
    }
  }

  const oracleExecutionsByTxHash = new Map<string, ProtocolOracleExecution[]>()
  for (const row of oracleRows) {
    const executions = oracleExecutionsByTxHash.get(row.tx_hash) ?? []
    executions.push({
      actions: parseActions(row.actions_json, row.tx_hash, row.log_index),
      ...(row.aggregated_signature
        ? { aggregatedSignature: row.aggregated_signature }
        : {}),
      idempotencyKey: row.idempotency_key,
      logIndex: row.log_index,
      oracleContractAddress: row.oracle_contract_address,
      ...(row.submitted_oracle_address
        ? { submittedOracleAddress: row.submitted_oracle_address }
        : {}),
    })
    oracleExecutionsByTxHash.set(row.tx_hash, executions)
  }

  for (const transfers of transfersByTxHash.values()) {
    sortByLogIndex(transfers)
  }
  for (const oracleExecutions of oracleExecutionsByTxHash.values()) {
    sortByLogIndex(oracleExecutions)
  }

  const data: ProtocolTransaction[] = []
  for (const txHash of txHashes) {
    const transfers = transfersByTxHash.get(txHash)
    if (!transfers?.length) {
      continue
    }

    const meta = transferMetaByTxHash.get(txHash)
    if (!meta) {
      continue
    }

    data.push({
      blockNumber: meta.blockNumber,
      oracleExecutions: oracleExecutionsByTxHash.get(txHash) ?? [],
      relayOperation: deriveRelayOperation(transfers),
      timestamp: new Date(meta.timestamp * 1000).toISOString(),
      transfers,
      txHash,
    })
  }

  return data
}

export const getProtocolTransactionsByHash = async (
  db: Database,
  txHashes: string[]
): Promise<ProtocolTransaction[]> => {
  if (!txHashes.length) {
    return []
  }

  const transferRows = await db.manyOrNone<ProtocolTransferRow>(
    `SELECT
       events.block_number,
       events.tx_hash,
       events.log_index,
       events.operator,
       events.from_addr,
       events.to_addr,
       events.token_id,
       events.amount,
       events.timestamp,
       tokens.name AS token_name,
       tokens.symbol AS token_symbol,
       tokens.decimals AS token_decimals
     FROM events
     LEFT JOIN tokens ON tokens.token_id = events.token_id
     WHERE events.tx_hash IN ($1:csv)
     ORDER BY events.block_number ASC, events.log_index ASC`,
    [txHashes]
  )

  const oracleRows = await db.manyOrNone<OracleExecutionRow>(
    `SELECT tx_hash, block_number, log_index, timestamp, oracle_contract_address, idempotency_key, actions_json, submitted_oracle_address, aggregated_signature
     FROM oracle_executions
     WHERE tx_hash IN ($1:csv)
     ORDER BY block_number ASC, log_index ASC`,
    [txHashes]
  )

  return projectProtocolTransactions({
    oracleRows,
    transferRows,
    txHashes,
  })
}
