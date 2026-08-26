import { RelayOracle } from "@relay-protocol/settlement-abis"
import { Interface } from "ethers"
import { Provider } from "ethers"
import type { Queryable } from "../db/connection.js"
import { insertOracleExecution } from "../db/oracleExecutions.js"
import { logger } from "../logger.js"

const relayOracleExecutionInterface = new Interface(RelayOracle)
const multicall3Interface = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
])

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
  transactionCache: Map<string, Promise<DecodedOracleTransaction[]>>
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

type Multicall3Call = {
  target?: string
  callData?: string
  0?: string
  2?: string
  3?: string
}

const decodeOracleTransactionCalls = (
  transactionTarget: string | null,
  data: string,
  oracleContractAddress: string,
  txHash: string
) => {
  const normalizedOracleAddress = oracleContractAddress.toLowerCase()
  if (transactionTarget?.toLowerCase() === normalizedOracleAddress) {
    return [decodeOracleTransaction(data)]
  }

  let parsedMulticall
  try {
    parsedMulticall = multicall3Interface.parseTransaction({ data })
  } catch {
    parsedMulticall = null
  }

  if (
    !parsedMulticall ||
    !["aggregate3", "aggregate3Value"].includes(parsedMulticall.name)
  ) {
    throw new Error(
      `Oracle transaction target mismatch for ${txHash}: ${transactionTarget ?? "contract creation"}`
    )
  }

  const calls = Array.from(parsedMulticall.args[0] as readonly Multicall3Call[])
  const oracleCalls = calls.filter(
    (call) =>
      String(call.target ?? call[0]).toLowerCase() === normalizedOracleAddress
  )

  if (!oracleCalls.length) {
    throw new Error(
      `Multicall3 transaction ${txHash} does not contain an Oracle call to ${oracleContractAddress}`
    )
  }

  const decodedCalls: DecodedOracleTransaction[] = []
  const decodeErrors: string[] = []
  const callDataIndex = parsedMulticall.name === "aggregate3Value" ? 3 : 2
  for (const call of oracleCalls) {
    try {
      decodedCalls.push(
        decodeOracleTransaction(
          String(call.callData ?? call[callDataIndex as 2 | 3])
        )
      )
    } catch (error) {
      decodeErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (!decodedCalls.length) {
    throw new Error(
      `Multicall3 Oracle calls could not be decoded for ${txHash}: ${decodeErrors.join("; ")}`
    )
  }

  return decodedCalls
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
    return decodeOracleTransactionCalls(
      transaction.to,
      transaction.data,
      context.oracleContractAddress,
      txHash
    )
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

  const decodedTransactions = await getDecodedOracleTransaction(
    context,
    log.transactionHash
  )
  const candidates = decodedTransactions.flatMap((transaction) =>
    transaction.executions.map((execution) => ({ execution, transaction }))
  )
  const matchingIdempotencyKey = candidates.filter(
    ({ execution }) => execution.idempotencyKey === parsedLog.idempotencyKey
  )
  const matchingExecution = matchingIdempotencyKey.find(({ execution }) =>
    actionsEqual(execution.actions, parsedLog.actions)
  )

  if (!matchingIdempotencyKey.length) {
    throw new Error(
      `Oracle execution ${parsedLog.idempotencyKey} not found in decoded transaction ${log.transactionHash}`
    )
  }

  if (!matchingExecution) {
    throw new Error(
      `Oracle execution ${parsedLog.idempotencyKey} actions mismatch for transaction ${log.transactionHash}`
    )
  }

  const { execution, transaction } = matchingExecution
  const normalized: NormalizedOracleExecution = {
    actions: parsedLog.actions,
    aggregatedSignature: execution.aggregatedSignature,
    blockNumber: log.blockNumber,
    executionCount: transaction.executions.length,
    executionIndex: execution.executionIndex,
    idempotencyKey: parsedLog.idempotencyKey,
    logIndex: log.index,
    method: transaction.method,
    oracleContractAddress: context.oracleContractAddress.toLowerCase(),
    submittedOracleAddress: transaction.submittedOracleAddress,
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
