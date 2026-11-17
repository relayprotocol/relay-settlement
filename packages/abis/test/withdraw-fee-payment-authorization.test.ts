import { Interface } from "ethers"
import { describe, expect, it } from "vitest"
import * as abis from "../src/index"

describe("withdraw fee authorization ABI", () => {
  it.each([false, true])(
    "encodes the grouped request authorization with fee=%s",
    (withFee) => {
      const allocator = new Interface(abis.RelayAllocator)
      const fragment = allocator.fragments.find(
        (entry) =>
          entry.type === "function" &&
          "name" in entry &&
          entry.name === "submitWithdrawRequestWithSignature" &&
          entry.inputs.length === (withFee ? 2 : 1)
      )!
      const request = {
        amount: 100n,
        chainId: "gateway",
        currency: "0x22",
        data: "0x",
        depository: "0x11",
        nonce: `0x${"00".repeat(32)}`,
        receiver: "0x44",
        spender: "0x33",
        spenderChainId: "relay",
      }
      const authorization = { expiration: 1_900_000_000n, signature: "0x1234" }
      const withdrawRequestAuthorization = {
        authorization,
        withdrawRequest: request,
      }
      const withdrawFeePaymentAuthorization = {
        authorization: { expiration: 1_900_000_001n, signature: "0x5678" },
        withdrawFeePayment: {
          currency: "0x22",
          maxAmount: 2n,
          payer: "0x55",
          payerChainId: "relay",
        },
      }
      const selector = fragment.format("sighash")
      const encoded = allocator.encodeFunctionData(selector, [
        withdrawRequestAuthorization,
        ...(withFee ? [withdrawFeePaymentAuthorization] : []),
      ])
      const decoded = allocator.decodeFunctionData(selector, encoded)
      expect(
        decoded.withdrawRequestAuthorization.authorization.expiration
      ).toBe(authorization.expiration)
      expect(decoded.withdrawRequestAuthorization.authorization.signature).toBe(
        authorization.signature
      )
      expect(decoded.withdrawRequestAuthorization.withdrawRequest.amount).toBe(
        request.amount
      )
      if (!withFee) return
      expect(
        decoded.withdrawFeePaymentAuthorization.authorization.expiration
      ).toBe(withdrawFeePaymentAuthorization.authorization.expiration)
      expect(
        decoded.withdrawFeePaymentAuthorization.authorization.signature
      ).toBe(withdrawFeePaymentAuthorization.authorization.signature)
      expect(
        decoded.withdrawFeePaymentAuthorization.withdrawFeePayment.maxAmount
      ).toBe(2n)
      expect(
        decoded.withdrawFeePaymentAuthorization.withdrawFeePayment.expiration
      ).toBeUndefined()
    }
  )

  it("does not export the removed prepayment contracts", () => {
    expect("WithdrawGasPayer" in abis).toBe(false)
    expect("GasPaidPayloadBuilder" in abis).toBe(false)
    expect("IWithdrawGasPayer" in abis).toBe(false)
  })
})
