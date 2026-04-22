import type { Queryable } from "./connection.js"
import type { NormalizedOracleExecution } from "../services/oracleExecutionProcessor.js"

export const insertOracleExecution = async (
  db: Queryable,
  execution: NormalizedOracleExecution
) => {
  const now = new Date().toISOString()
  return db.result(
    `INSERT INTO oracle_executions(
      tx_hash,
      block_number,
      log_index,
      timestamp,
      oracle_contract_address,
      idempotency_key,
      actions_json,
      submitted_oracle_address,
      aggregated_signature,
      created_at,
      updated_at
    ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT(tx_hash, log_index) DO NOTHING
     RETURNING 1`,
    [
      execution.txHash,
      execution.blockNumber,
      execution.logIndex,
      execution.timestamp,
      execution.oracleContractAddress,
      execution.idempotencyKey,
      JSON.stringify(execution.actions),
      execution.submittedOracleAddress,
      execution.aggregatedSignature,
      now,
      now,
    ],
    (result) => result.rowCount
  )
}
