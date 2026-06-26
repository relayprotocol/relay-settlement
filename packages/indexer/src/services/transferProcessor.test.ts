import assert from "node:assert/strict"
import test from "node:test"
import { RelayHub } from "@relay-protocol/settlement-abis"
import { Interface, ZeroAddress } from "ethers"
import { parseTransferLog } from "./transferProcessor.js"

const relayHubInterface = new Interface(RelayHub)
const transferEvent = relayHubInterface.getEvent("Transfer")

if (!transferEvent) {
  throw new Error("Transfer event not found")
}

test("parseTransferLog normalizes RelayHub transfer args", () => {
  const operator = "0xd4b9fdB83C723c096d7fBE72da252aa23f1387aa"
  const from = "0x0001F16A09C22494Fe30e4672e348c33b2a9b440"
  const to = ZeroAddress
  const tokenId =
    39933202808546087802869879985528636781975034114388371807707135717145122528969n
  const amount = 28034508121n
  const encoded = relayHubInterface.encodeEventLog(transferEvent, [
    operator,
    from,
    to,
    tokenId,
    amount,
  ])

  const parsed = parseTransferLog({
    data: encoded.data,
    topics: encoded.topics,
  })

  assert.deepEqual(parsed, {
    amount,
    from,
    operator,
    to,
    tokenId: tokenId.toString(),
  })
})

test("parseTransferLog returns null for malformed transfer data", () => {
  const parsed = parseTransferLog({
    data: "0x",
    topics: [transferEvent.topicHash],
  })

  assert.equal(parsed, null)
})
