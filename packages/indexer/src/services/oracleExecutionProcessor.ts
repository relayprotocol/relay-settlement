import { RelayOracle } from "@relay-protocol/settlement-abis"
import { Interface } from "ethers"
import { Provider } from "ethers"
import type { Queryable } from "../db/connection.js"
import { insertOracleExecution } from "../db/oracleExecutions.js"
import { logger } from "../logger.js"

const relayOracleExecutionInterface = new Interface(RelayOracle)

type OracleExecutionLog = {
  eventType: "Executed" | "ExecutionFailed"
  idempotencyKey: string
  actions: string[]
}

type DecodedOracleExecution = {
  idempotencyKey: string
  actions: string[]
  aggregatedSignature: string
  executionIndex: number
}

type DecodedOracleTransaction = {
  method: "execute" | "executeMultiple"
  submittedOracleAddress: string | null
  executions: DecodedOracleExecution[]
}

export type NormalizedOracleExecution = {
  txHash: string
  blockNumber: number
  logIndex: number
  timestamp: number
  oracleContractAddress: string
  idempotencyKey: string
  actions: string[]
  submittedOracleAddress: string | null
  aggregatedSignature: string
  executionIndex: number
  executionCount: number
  method: "execute" | "executeMultiple"
}

export type OracleExecutionProcessingContext = {
  provider: Provider
  oracleContractAddress: string
  transactionCache: Map<string, Promise<DecodedOracleTransaction>>
}

const normalizeHex = (value: string) => value.toLowerCase()

const normalizeActions = (values: readonly string[]) =>
  Array.from(values, (value) => normalizeHex(String(value)))

const normalizeExecutionStruct = (
  execution: {
    idempotencyKey?: string
    actions?: readonly string[]
    0?: string
    1?: readonly string[]
  },
  executionIndex: number,
  aggregatedSignature: string
): DecodedOracleExecution => ({
  actions: normalizeActions(execution.actions ?? execution[1] ?? []),
  aggregatedSignature: normalizeHex(aggregatedSignature),
  executionIndex,
  idempotencyKey: normalizeHex(
    String(execution.idempotencyKey ?? execution[0] ?? "")
  ),
})

const actionsEqual = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index])

export const parseOracleExecutionLog = (log: {
  topics: readonly string[]
  data: string
}): OracleExecutionLog | null => {
  try {
    const parsed = relayOracleExecutionInterface.parseLog(log)
    if (!parsed) return null
    if (parsed.name !== "Executed" && parsed.name !== "ExecutionFailed") {
      return null
    }
    return {
      actions: normalizeActions(parsed.args.actions as readonly string[]),
      eventType: parsed.name,
      idempotencyKey: normalizeHex(String(parsed.args.idempotencyKey)),
    }
  } catch {
    return null
  }
}

export const decodeOracleTransaction = (
  data: string
): DecodedOracleTransaction => {
  const parsed = relayOracleExecutionInterface.parseTransaction({ data })
  if (!parsed) {
    throw new Error("Oracle transaction input could not be decoded")
  }
  const hasOracleArgument = parsed.fragment.inputs[1]?.type === "address"

  if (parsed.name === "execute") {
    const execution = normalizeExecutionStruct(
      parsed.args[0] as unknown as {
        idempotencyKey?: string
        actions?: readonly string[]
        0?: string
        1?: readonly string[]
      },
      0,
      String(parsed.args[hasOracleArgument ? 2 : 1])
    )
    return {
      executions: [execution],
      method: "execute",
      submittedOracleAddress: hasOracleArgument
        ? normalizeHex(String(parsed.args[1]))
        : null,
    }
  }

  if (parsed.name === "executeMultiple") {
    const signatures = Array.from(
      parsed.args[hasOracleArgument ? 2 : 1] as readonly string[],
      (value) => String(value)
    )
    const executions = Array.from(
      parsed.args[0] as Array<{
        idempotencyKey?: string
        actions?: readonly string[]
        0?: string
        1?: readonly string[]
      }>
    )

    if (executions.length !== signatures.length) {
      throw new Error(
        `Oracle batch decode mismatch: executions=${executions.length}, signatures=${signatures.length}`
      )
    }

    return {
      executions: executions.map((execution, index) =>
        normalizeExecutionStruct(execution, index, signatures[index])
      ),
      method: "executeMultiple",
      submittedOracleAddress: hasOracleArgument
        ? normalizeHex(String(parsed.args[1]))
        : null,
    }
  }

  throw new Error(`Unsupported oracle transaction method: ${parsed.name}`)
}

const getDecodedOracleTransaction = async (
  context: OracleExecutionProcessingContext,
  txHash: string
) => {
  const existing = context.transactionCache.get(txHash)
  if (existing) {
    return existing
  }

  const promise = (async () => {
    const transaction = await context.provider.getTransaction(txHash)
    if (!transaction) {
      throw new Error(`Oracle transaction not found: ${txHash}`)
    }
    if (!transaction.data) {
      throw new Error(`Oracle transaction missing calldata: ${txHash}`)
    }
    if (
      transaction.to &&
      transaction.to.toLowerCase() !==
        context.oracleContractAddress.toLowerCase()
    ) {
      throw new Error(
        `Oracle transaction target mismatch for ${txHash}: ${transaction.to}`
      )
    }
    return decodeOracleTransaction(transaction.data)
  })().catch((error) => {
    context.transactionCache.delete(txHash)
    throw error
  })

  context.transactionCache.set(txHash, promise)
  return promise
}

export const processOracleExecutionLog = async (
  context: OracleExecutionProcessingContext,
  log: {
    blockNumber: number
    transactionHash: string
    index: number
    topics: readonly string[]
    data: string
  },
  timestamp: number
): Promise<NormalizedOracleExecution | null> => {
  const parsedLog = parseOracleExecutionLog(log)
  if (!parsedLog) {
    throw new Error("Oracle execution log could not be decoded")
  }

  if (parsedLog.eventType === "ExecutionFailed") {
    logger.warn("oracle-execution", "Oracle execution failed onchain", {
      blockNumber: log.blockNumber,
      contractAddress: context.oracleContractAddress,
      idempotencyKey: parsedLog.idempotencyKey,
      logIndex: log.index,
      txHash: log.transactionHash,
    })
    return null
  }

  const decodedTransaction = await getDecodedOracleTransaction(
    context,
    log.transactionHash
  )
  const matchingExecution = decodedTransaction.executions.find(
    (execution) => execution.idempotencyKey === parsedLog.idempotencyKey
  )

  if (!matchingExecution) {
    throw new Error(
      `Oracle execution ${parsedLog.idempotencyKey} not found in decoded transaction ${log.transactionHash}`
    )
  }

  if (!actionsEqual(matchingExecution.actions, parsedLog.actions)) {
    throw new Error(
      `Oracle execution ${parsedLog.idempotencyKey} actions mismatch for transaction ${log.transactionHash}`
    )
  }

  const normalized: NormalizedOracleExecution = {
    actions: parsedLog.actions,
    aggregatedSignature: matchingExecution.aggregatedSignature,
    blockNumber: log.blockNumber,
    executionCount: decodedTransaction.executions.length,
    executionIndex: matchingExecution.executionIndex,
    idempotencyKey: parsedLog.idempotencyKey,
    logIndex: log.index,
    method: decodedTransaction.method,
    oracleContractAddress: context.oracleContractAddress.toLowerCase(),
    submittedOracleAddress: decodedTransaction.submittedOracleAddress,
    timestamp,
    txHash: log.transactionHash,
  }

  logger.info("oracle-execution", "Oracle execution processed", {
    blockNumber: normalized.blockNumber,
    contractAddress: normalized.oracleContractAddress,
    executionCount: normalized.executionCount,
    executionIndex: normalized.executionIndex,
    idempotencyKey: normalized.idempotencyKey,
    logIndex: normalized.logIndex,
    method: normalized.method,
    txHash: normalized.txHash,
  })

  return normalized
}

export const processAndStoreOracleExecutionLog = async (
  db: Queryable,
  context: OracleExecutionProcessingContext,
  log: {
    blockNumber: number
    transactionHash: string
    index: number
    topics: readonly string[]
    data: string
  },
  timestamp: number
) => {
  const normalized = await processOracleExecutionLog(context, log, timestamp)
  if (!normalized) {
    return null
  }

  const inserted = await insertOracleExecution(db, normalized)
  logger.info("oracle-execution", "Oracle execution stored", {
    idempotencyKey: normalized.idempotencyKey,
    inserted,
    logIndex: normalized.logIndex,
    txHash: normalized.txHash,
  })

  return normalized
}
