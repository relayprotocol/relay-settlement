import { getWithdrawRequestAuthorizationHash } from "../src/messages/v2.4/withdraw-request-authorization"
import { describe, expect, it } from "vitest"
import {
  getWithdrawFeePaymentAuthorizationHash,
  WithdrawFeePayment,
} from "../src/messages/v2.4/withdrawal"
import {
  getWithdrawRequestHash,
  getExecuteAndWithdrawRequestHash,
  WithdrawRequest,
} from "../src/messages/v2.3/withdrawal"
import * as sdk from "../src"

const request: WithdrawRequest = {
  chainId: "gateway",
  depository: "0x11",
  currency: "0x22",
  amount: "1000000",
  spenderChainId: "relay",
  spender: "0x33",
  receiver: "0x44",
  data: "0x55",
  nonce: `0x${"00".repeat(31)}01`,
}
const allocator = "0x0000000000000000000000000000000000001234"
const withdrawFeePayment: WithdrawFeePayment = {
  payerChainId: "relay",
  payer: "0x66",
  currency: "0x22",
  maxAmount: "50050",
}
const expiration = 2000000000n
const hash = (r = request, p = withdrawFeePayment, exp = expiration) =>
  getWithdrawFeePaymentAuthorizationHash(31337, allocator, r, p, exp)

describe("v2.4 separate withdrawal fee authorization", () => {
  it("matches the independent Solidity vector", () => {
    expect(hash()).toBe(
      "0xf564caaa347d2be6e2d0c172456ceacd1fbdf99bf941acc491c4c322eff6657d"
    )
  })
  it("allows a runtime amount without changing canonical withdrawal identities", () => {
    const changed = { ...request, amount: "2000000" }
    expect(hash(changed)).toBe(hash())
    expect(getWithdrawRequestHash(changed)).not.toBe(
      getWithdrawRequestHash(request)
    )
    expect(
      getWithdrawRequestAuthorizationHash(31337, allocator, {
        request: changed,
        expiration,
      })
    ).not.toBe(
      getWithdrawRequestAuthorizationHash(31337, allocator, {
        request: request,
        expiration,
      })
    )
  })
  it.each([
    { chainId: "other" },
    { depository: "0x12" },
    { currency: "0x23" },
    { spenderChainId: "other" },
    { spender: "0x34" },
    { receiver: "0x45" },
    { data: "0x56" },
    { nonce: `0x${"00".repeat(31)}02` },
  ])("binds the withdrawal details %j", (change) => {
    expect(hash({ ...request, ...change })).not.toBe(hash())
  })
  it.each<Partial<WithdrawFeePayment>>([
    { payerChainId: "other" },
    { payer: "0x67" },
    { currency: "0x23" },
    { maxAmount: "50051" },
  ])("binds the payer and payment terms %j", (change) => {
    expect(hash(request, { ...withdrawFeePayment, ...change })).not.toBe(hash())
  })
  it("binds the authorization expiration", () => {
    expect(hash(request, withdrawFeePayment, expiration + 1n)).not.toBe(hash())
  })
  it("binds the allocator and Hub chain", () => {
    expect(
      getWithdrawFeePaymentAuthorizationHash(
        1,
        allocator,
        request,
        withdrawFeePayment,
        expiration
      )
    ).not.toBe(hash())
    expect(
      getWithdrawFeePaymentAuthorizationHash(
        31337,
        "0x0000000000000000000000000000000000001235",
        request,
        withdrawFeePayment,
        expiration
      )
    ).not.toBe(hash())
  })
  it("pins the expiring request authorization vector", () => {
    expect(
      getWithdrawRequestAuthorizationHash(31337, allocator, {
        request: request,
        expiration,
      })
    ).toBe("0x89aa1464237f5f36705ef5b77b7937c6bdbb8df4f741f3b09580ec234293cce4")
  })
  it("exports fee helpers while preserving the existing executor signing schema", () => {
    expect(sdk.getWithdrawFeePaymentAuthorizationHash).toBe(
      getWithdrawFeePaymentAuthorizationHash
    )
    expect(sdk.getWithdrawRequestAuthorizationHash).toBe(
      getWithdrawRequestAuthorizationHash
    )
    expect(sdk.getExecuteAndWithdrawRequestHash).toBe(
      getExecuteAndWithdrawRequestHash
    )
  })
})
