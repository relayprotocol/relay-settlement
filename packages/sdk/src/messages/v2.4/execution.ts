import { Address, Hex, hashTypedData } from "viem"

import { ExecutionMessage } from "../v2.2/execution"

// Mirrors `RelayInbox.Execution`. `expiration` is the last valid Unix
// second for the oracle signature
export type OracleExecution = {
  idempotencyKey: string
  // Encoded actions, see `encodeAction` in v2.2/execution
  actions: string[]
  expiration: bigint
}

// Successor of the v2.2 `ExecutionMessage` for the expiration-bearing oracle
export type OracleExecutionMessage = ExecutionMessage & OracleExecution

// Field order is part of the `RelayInbox` execution typehash
export const oracleExecutionTypes = {
  Execution: [
    { name: "idempotencyKey", type: "bytes32" },
    { name: "actions", type: "bytes[]" },
    { name: "expiration", type: "uint256" },
  ],
} as const

const oracleDomain = (chainId: number, oracle: Address) => ({
  name: "RelayInbox",
  version: "1",
  chainId,
  verifyingContract: oracle,
})

// The EIP-712 digest the oracle signs for `RelayInbox.execute`
export const getOracleExecutionHash = (
  chainId: number,
  oracle: Address,
  execution: OracleExecution
) =>
  hashTypedData({
    domain: oracleDomain(chainId, oracle),
    types: oracleExecutionTypes,
    primaryType: "Execution",
    message: {
      idempotencyKey: execution.idempotencyKey as Hex,
      actions: execution.actions as Hex[],
      expiration: execution.expiration,
    },
  })
