/*
 * Generates the Highload V3 `msg_inner` cell hashes used as reference
 * vectors in test/PayloadBuilders/TonVmPayloadBuilder.t.sol.
 *
 * Run with: `npx ts-node tools/ton-reference-hashes.ts` from the
 * smart-contracts directory (requires `@ton/core` to be available in the
 * workspace).
 *
 * The Highload V3 wallet signs `cell_hash(msg_inner)`, where msg_inner is:
 *   subwallet_id  uint32
 *   ref → message_to_send         (internal MessageRelaxed for the transfer)
 *   send_mode     uint8
 *   shift         uint13          ┐  HighloadQueryId
 *   bit_number    uint10          ┘  = (shift << 10) | bit_number
 *   created_at    uint64
 *   timeout       uint22
 *
 * For native TON the wrapped MessageRelaxed is generated with `internal({...})`
 * and is `bounce: false` (matches the on-chain builder's BOUNCE constant).
 */

import { Address, beginCell, internal, storeMessageRelaxed } from "@ton/core"

interface Vector {
  label: string
  receiverHash: string
  amount: bigint
  createdAt: number
  queryId: number
}

const SUBWALLET_ID = 0x10ad0001
const TIMEOUT = 3600
const SEND_MODE = 1
const BOUNCE = false

const vectors: Vector[] = [
  {
    label: "V1: zero fields",
    receiverHash:
      "0000000000000000000000000000000000000000000000000000000000000000",
    amount: 0n,
    createdAt: 1700000000,
    queryId: 0,
  },
  {
    label: "V2: typical native TON transfer",
    receiverHash:
      "1122334455667788990011223344556677889900112233445566778899001122",
    amount: 100000000n,
    createdAt: 1735680000,
    queryId: 42,
  },
  {
    // queryId = 2^23 - 2 (NOT 2^23 - 1): Highload V3 rejects bit_number = 1023
    // and the builder remaps that single forbidden value down to 0. The max
    // *valid* queryId is therefore 0x7FFFFE (shift = 0x1FFF, bit_number = 1022).
    label: "V3: amount at VarUInteger16 boundary, max valid queryId",
    receiverHash:
      "1122334455667788990011223344556677889900112233445566778899001122",
    amount: (1n << 120n) - 1n,
    createdAt: 2000000000,
    queryId: (1 << 23) - 2,
  },
]

const main = () => {
  for (const v of vectors) {
    const receiver = new Address(0, Buffer.from(v.receiverHash, "hex"))

    const messageCell = beginCell()
      .store(
        storeMessageRelaxed(
          internal({ to: receiver, value: v.amount, bounce: BOUNCE })
        )
      )
      .endCell()

    const shift = v.queryId >>> 10
    const bitNumber = v.queryId & 0x3ff
    const innerCell = beginCell()
      .storeUint(SUBWALLET_ID, 32)
      .storeRef(messageCell)
      .storeUint(SEND_MODE, 8)
      .storeUint(shift, 13)
      .storeUint(bitNumber, 10)
      .storeUint(BigInt(v.createdAt), 64)
      .storeUint(TIMEOUT, 22)
      .endCell()

    console.log(v.label)
    console.log("  message cell hash: 0x" + messageCell.hash().toString("hex"))
    console.log("  inner cell hash:   0x" + innerCell.hash().toString("hex"))
    console.log()
  }
}

main()
