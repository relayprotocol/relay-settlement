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

test("coverage token lookup agrees with the ABI parser for canonical and non-canonical transfers", async () => {
  const { getTransferTokenId } = await import("./transferProcessor.js")
  for (const tokenId of [0n, 1n, (1n << 256n) - 1n]) {
    const encoded = relayHubInterface.encodeEventLog(transferEvent, [
      ZeroAddress,
      ZeroAddress,
      ZeroAddress,
      tokenId,
      0n,
    ])
    const variants = [
      encoded,
      { ...encoded, data: encoded.data + "00".repeat(32) },
      { ...encoded, data: "0x" },
      { ...encoded, topics: encoded.topics.slice(0, 2) },
      { ...encoded, topics: [...encoded.topics, "0x" + "00".repeat(32)] },
      { ...encoded, data: "0x" + "f".repeat(64) + encoded.data.slice(66) },
      {
        ...encoded,
        topics: encoded.topics.map(
          (topic) => "0x" + topic.slice(2).toUpperCase()
        ),
      },
      {
        ...encoded,
        topics: [
          encoded.topics[0],
          "0x" + "f".repeat(64),
          ...encoded.topics.slice(2),
        ],
      },
    ]
    for (const variant of variants)
      assert.equal(
        getTransferTokenId(variant),
        parseTransferLog(variant)?.tokenId ?? null
      )
  }
})
