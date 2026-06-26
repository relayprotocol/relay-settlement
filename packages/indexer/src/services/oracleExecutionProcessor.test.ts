import test from "node:test"
import assert from "node:assert/strict"
import { Interface, ZeroAddress } from "ethers"
import { RelayOracle } from "@relay-protocol/settlement-abis"
import { decodeOracleTransaction } from "./oracleExecutionProcessor.js"

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

const execution = {
  actions: ["0x1234", "0xabcd"],
  idempotencyKey: "0x" + "11".repeat(32),
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
