import { describe, it, expect } from "vitest"
import { Hex, hashStruct } from "viem"

import {
  getGenericMappingMessageId,
  getNoFillOrRefundMessage,
  getWithdrawParamsMappingMessage,
} from "../src/messages/v2.2/generic-mapping"
import { genericMappingSetEntryTypes } from "../src/messages/v2.4/generic-mapping"

const solver = "0x" + "11".repeat(20)
const otherSolver = "0x" + "22".repeat(20)
const withdrawParamsHash = "0x" + "ab".repeat(32)
const orderId = "0x" + "cd".repeat(32)

describe("getWithdrawParamsMappingMessage", () => {
  it("is deterministic", () => {
    expect(
      getWithdrawParamsMappingMessage(solver, withdrawParamsHash, orderId)
    ).toEqual(
      getWithdrawParamsMappingMessage(solver, withdrawParamsHash, orderId)
    )
  })

  it("stores the order id as the entry data", () => {
    const message = getWithdrawParamsMappingMessage(
      solver,
      withdrawParamsHash,
      orderId
    )

    expect(message.user).toBe(solver)
    expect(message.data).toBe(orderId)
  })

  it("keys the entry by the withdraw params hash only", () => {
    const { id } = getWithdrawParamsMappingMessage(
      solver,
      withdrawParamsHash,
      orderId
    )

    // Scoped by `user`, not by the entry id
    expect(
      getWithdrawParamsMappingMessage(otherSolver, withdrawParamsHash, orderId)
        .id
    ).toBe(id)
    expect(
      getWithdrawParamsMappingMessage(
        solver,
        withdrawParamsHash,
        "0x" + "ef".repeat(32)
      ).id
    ).toBe(id)
    expect(
      getWithdrawParamsMappingMessage(solver, "0x" + "ba".repeat(32), orderId)
        .id
    ).not.toBe(id)
  })

  it("scopes the nonce to the solver and the withdrawal", () => {
    const { nonce } = getWithdrawParamsMappingMessage(
      solver,
      withdrawParamsHash,
      orderId
    )

    expect(
      getWithdrawParamsMappingMessage(otherSolver, withdrawParamsHash, orderId)
        .nonce
    ).not.toBe(nonce)
    expect(
      getWithdrawParamsMappingMessage(solver, "0x" + "ba".repeat(32), orderId)
        .nonce
    ).not.toBe(nonce)
  })

  it("does not collide with other generic mapping entries", () => {
    expect(
      getWithdrawParamsMappingMessage(solver, withdrawParamsHash, orderId).id
    ).not.toBe(getNoFillOrRefundMessage(solver, withdrawParamsHash).id)
  })

  it("hashes to a signable generic mapping id", () => {
    const message = getWithdrawParamsMappingMessage(
      solver,
      withdrawParamsHash,
      orderId
    )

    expect(getGenericMappingMessageId(message)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  // Deliberate divergence: the v2.2 id is the pre-expiration struct hash, which
  // the post-#930 mapping rejects; v2.4 binds `expiration`
  it("is not the v2.4 SetEntry struct hash", () => {
    const message = getWithdrawParamsMappingMessage(
      solver,
      withdrawParamsHash,
      orderId
    )

    expect(getGenericMappingMessageId(message)).not.toBe(
      hashStruct({
        types: genericMappingSetEntryTypes,
        primaryType: "SetEntry",
        data: {
          user: message.user as Hex,
          id: message.id as Hex,
          data: message.data as Hex,
          nonce: message.nonce as Hex,
          expiration: 0n,
        },
      })
    )
  })
})
