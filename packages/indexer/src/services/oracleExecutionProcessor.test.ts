import test from "node:test"
import assert from "node:assert/strict"
import { Interface, type Provider, ZeroAddress } from "ethers"
import { RelayOracle } from "@relay-protocol/settlement-abis"
import {
  decodeOracleTransaction,
  processOracleExecutionLog,
} from "./oracleExecutionProcessor.js"

const legacyRelayOracleAbi = [
  {
    inputs: [
      {
        components: [
          { internalType: "bytes32", name: "idempotencyKey", type: "bytes32" },
          { internalType: "bytes[]", name: "actions", type: "bytes[]" },
        ],
        internalType: "struct RelayOracle.Execution",
        name: "execution",
        type: "tuple",
      },
      { internalType: "bytes", name: "signature", type: "bytes" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
]

const currentRelayOracleAbi = [
  {
    inputs: [
      {
        components: [
          { internalType: "bytes32", name: "idempotencyKey", type: "bytes32" },
          { internalType: "bytes[]", name: "actions", type: "bytes[]" },
        ],
        internalType: "struct RelayOracle.Execution[]",
        name: "executions",
        type: "tuple[]",
      },
      { internalType: "address", name: "oracle", type: "address" },
      { internalType: "bytes[]", name: "signatures", type: "bytes[]" },
    ],
    name: "executeMultiple",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { internalType: "bytes32", name: "idempotencyKey", type: "bytes32" },
          { internalType: "bytes[]", name: "actions", type: "bytes[]" },
        ],
        internalType: "struct RelayOracle.Execution",
        name: "execution",
        type: "tuple",
      },
      { internalType: "address", name: "oracle", type: "address" },
      { internalType: "bytes", name: "signature", type: "bytes" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
]

const legacyInterface = new Interface(legacyRelayOracleAbi)
const currentInterface = new Interface(currentRelayOracleAbi)
const mergedInterface = new Interface(RelayOracle)
const executedEvent = mergedInterface.getEvent("Executed")
if (!executedEvent) {
  throw new Error("RelayOracle Executed event is missing from the merged ABI")
}
const multicall3Interface = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
])

const execution = {
  actions: ["0x1234", "0xabcd"],
  idempotencyKey: "0x" + "11".repeat(32),
}
const oracleContractAddress = "0xd4b9fdB83C723c096d7fBE72da252aa23f1387aa"
const multicallAddress = "0x403251A47f2D11bd9C899C12372D43BF07535595"

const executionLog = (
  value: typeof execution,
  transactionHash = "0x" + "aa".repeat(32),
  index = 1
) => {
  const encoded = mergedInterface.encodeEventLog(executedEvent, [
    value.idempotencyKey,
    value.actions,
  ])

  return {
    blockNumber: 123,
    data: encoded.data,
    index,
    topics: encoded.topics,
    transactionHash,
  }
}

test("decodeOracleTransaction supports the legacy oracle ABI", () => {
  const data = legacyInterface.encodeFunctionData("execute", [
    execution,
    "0xdeadbeef",
  ])

  const decoded = decodeOracleTransaction(data)

  assert.equal(decoded.method, "execute")
  assert.equal(decoded.submittedOracleAddress, null)
  assert.equal(decoded.executions.length, 1)
  assert.equal(decoded.executions[0].idempotencyKey, execution.idempotencyKey)
  assert.deepEqual(decoded.executions[0].actions, execution.actions)
  assert.equal(decoded.executions[0].aggregatedSignature, "0xdeadbeef")
})

test("decodeOracleTransaction supports the current oracle ABI", () => {
  const oracle = "0x1234567890123456789012345678901234567890"
  const data = currentInterface.encodeFunctionData("executeMultiple", [
    [execution],
    oracle,
    ["0xcafebabe"],
  ])

  const decoded = decodeOracleTransaction(data)

  assert.equal(decoded.method, "executeMultiple")
  assert.equal(decoded.submittedOracleAddress, oracle.toLowerCase())
  assert.equal(decoded.executions.length, 1)
  assert.equal(decoded.executions[0].idempotencyKey, execution.idempotencyKey)
  assert.deepEqual(decoded.executions[0].actions, execution.actions)
  assert.equal(decoded.executions[0].aggregatedSignature, "0xcafebabe")
})

test("merged RelayOracle ABI can still parse legacy and current execute selectors", () => {
  const legacyData = legacyInterface.encodeFunctionData("execute", [
    execution,
    "0xdeadbeef",
  ])
  const currentData = currentInterface.encodeFunctionData("execute", [
    execution,
    ZeroAddress,
    "0xcafebabe",
  ])

  const parsedLegacy = mergedInterface.parseTransaction({ data: legacyData })
  const parsedCurrent = mergedInterface.parseTransaction({ data: currentData })

  assert.equal(parsedLegacy?.name, "execute")
  assert.equal(parsedCurrent?.name, "execute")
  assert.equal(parsedLegacy?.fragment.inputs.length, 2)
  assert.equal(parsedCurrent?.fragment.inputs.length, 3)
})

test("processOracleExecutionLog preserves direct Oracle transaction support", async () => {
  const data = legacyInterface.encodeFunctionData("execute", [
    execution,
    "0xdeadbeef",
  ])
  const context = {
    oracleContractAddress,
    provider: {
      getTransaction: async () => ({
        data,
        to: oracleContractAddress,
      }),
    } as unknown as Provider,
    transactionCache: new Map(),
  }

  const normalized = await processOracleExecutionLog(
    context,
    executionLog(execution),
    456
  )

  assert.equal(normalized?.method, "execute")
  assert.equal(normalized?.aggregatedSignature, "0xdeadbeef")
  assert.equal(normalized?.executionCount, 1)
  assert.equal(normalized?.executionIndex, 0)
})

test("processOracleExecutionLog supports Oracle calls inside Multicall3 aggregate3", async () => {
  const oracle = "0x1234567890123456789012345678901234567890"
  const oracleData = currentInterface.encodeFunctionData("executeMultiple", [
    [execution],
    oracle,
    ["0xcafebabe"],
  ])
  const data = multicall3Interface.encodeFunctionData("aggregate3", [
    [
      {
        allowFailure: false,
        callData: oracleData,
        target: oracleContractAddress,
      },
    ],
  ])
  const context = {
    oracleContractAddress,
    provider: {
      getTransaction: async () => ({
        data,
        to: multicallAddress,
      }),
    } as unknown as Provider,
    transactionCache: new Map(),
  }

  const normalized = await processOracleExecutionLog(
    context,
    executionLog(execution),
    456
  )

  assert.equal(normalized?.method, "executeMultiple")
  assert.equal(normalized?.executionCount, 1)
  assert.equal(normalized?.executionIndex, 0)
  assert.equal(normalized?.submittedOracleAddress, oracle.toLowerCase())
  assert.equal(normalized?.aggregatedSignature, "0xcafebabe")
})

test("processOracleExecutionLog supports Oracle calls inside Multicall3 aggregate3Value", async () => {
  const oracleData = legacyInterface.encodeFunctionData("execute", [
    execution,
    "0xdeadbeef",
  ])
  const data = multicall3Interface.encodeFunctionData("aggregate3Value", [
    [
      {
        allowFailure: false,
        callData: oracleData,
        target: oracleContractAddress,
        value: 0,
      },
    ],
  ])
  const context = {
    oracleContractAddress,
    provider: {
      getTransaction: async () => ({
        data,
        to: multicallAddress,
      }),
    } as unknown as Provider,
    transactionCache: new Map(),
  }

  const normalized = await processOracleExecutionLog(
    context,
    executionLog(execution),
    456
  )

  assert.equal(normalized?.method, "execute")
  assert.equal(normalized?.aggregatedSignature, "0xdeadbeef")
})

test("processOracleExecutionLog matches executions across multiple Oracle subcalls", async () => {
  const secondExecution = {
    actions: ["0xbeef"],
    idempotencyKey: "0x" + "22".repeat(32),
  }
  const firstCall = currentInterface.encodeFunctionData("executeMultiple", [
    [execution],
    ZeroAddress,
    ["0xcafebabe"],
  ])
  const secondCall = legacyInterface.encodeFunctionData("execute", [
    secondExecution,
    "0xdeadbeef",
  ])
  const data = multicall3Interface.encodeFunctionData("aggregate3", [
    [
      {
        allowFailure: false,
        callData: firstCall,
        target: oracleContractAddress,
      },
      {
        allowFailure: false,
        callData: "0x1234",
        target: "0x1111111111111111111111111111111111111111",
      },
      {
        allowFailure: false,
        callData: secondCall,
        target: oracleContractAddress,
      },
    ],
  ])
  let transactionRequests = 0
  const context = {
    oracleContractAddress,
    provider: {
      getTransaction: async () => {
        transactionRequests += 1
        return {
          data,
          to: multicallAddress,
        }
      },
    } as unknown as Provider,
    transactionCache: new Map(),
  }

  const first = await processOracleExecutionLog(
    context,
    executionLog(execution),
    456
  )
  const second = await processOracleExecutionLog(
    context,
    executionLog(secondExecution, "0x" + "aa".repeat(32), 2),
    456
  )

  assert.equal(first?.method, "executeMultiple")
  assert.equal(first?.aggregatedSignature, "0xcafebabe")
  assert.equal(second?.method, "execute")
  assert.equal(second?.aggregatedSignature, "0xdeadbeef")
  assert.equal(second?.executionCount, 1)
  assert.equal(second?.executionIndex, 0)
  assert.equal(transactionRequests, 1)
})

test("processOracleExecutionLog rejects Multicall3 transactions without an Oracle call", async () => {
  const data = multicall3Interface.encodeFunctionData("aggregate3", [
    [
      {
        allowFailure: false,
        callData: "0x1234",
        target: "0x1111111111111111111111111111111111111111",
      },
    ],
  ])
  const context = {
    oracleContractAddress,
    provider: {
      getTransaction: async () => ({
        data,
        to: multicallAddress,
      }),
    } as unknown as Provider,
    transactionCache: new Map(),
  }

  await assert.rejects(
    processOracleExecutionLog(context, executionLog(execution), 456),
    /Multicall3 transaction .* does not contain an Oracle call/
  )
})

test("processOracleExecutionLog rejects unrelated transaction targets", async () => {
  const transactionHash = "0x" + "aa".repeat(32)
  const context = {
    oracleContractAddress,
    provider: {
      getTransaction: async () => ({
        data: "0x1234",
        to: multicallAddress,
      }),
    } as unknown as Provider,
    transactionCache: new Map(),
  }

  await assert.rejects(
    processOracleExecutionLog(
      context,
      executionLog(execution, transactionHash),
      456
    ),
    new RegExp(
      `Oracle transaction target mismatch for ${transactionHash}: ${multicallAddress}`,
      "i"
    )
  )
})
