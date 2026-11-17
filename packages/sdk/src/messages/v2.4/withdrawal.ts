import { Address, Hex, hashTypedData } from "viem"
import { Authorization } from "./authorization"
import { WithdrawRequest } from "../v2.3/withdrawal"

const withdrawRequestFields = [
  { name: "chainId", type: "string" },
  { name: "depository", type: "bytes" },
  { name: "currency", type: "bytes" },
  { name: "amount", type: "uint256" },
  { name: "spenderChainId", type: "string" },
  { name: "spender", type: "bytes" },
  { name: "receiver", type: "bytes" },
  { name: "data", type: "bytes" },
  { name: "nonce", type: "bytes32" },
] as const

export type WithdrawFeePayment = {
  payerChainId: string
  payer: Hex
  currency: Hex
  maxAmount: string
}

export type WithdrawFeePaymentAuthorization = {
  withdrawFeePayment: WithdrawFeePayment
  authorization: Authorization
}

export const withdrawFeePaymentAuthorizationTypes = {
  WithdrawFeePaymentAuthorization: [
    { name: "request", type: "WithdrawRequest" },
    { name: "withdrawFeePayment", type: "WithdrawFeePayment" },
    { name: "expiration", type: "uint256" },
  ],
  WithdrawRequest: withdrawRequestFields,
  WithdrawFeePayment: [
    { name: "payerChainId", type: "string" },
    { name: "payer", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "maxAmount", type: "uint256" },
  ],
} as const

const encodeRequest = (request: WithdrawRequest) => ({
  ...request,
  depository: request.depository as Hex,
  currency: request.currency as Hex,
  amount: BigInt(request.amount),
  spender: request.spender as Hex,
  receiver: request.receiver as Hex,
  data: request.data as Hex,
  nonce: request.nonce as Hex,
})

// Oracle authorization for one separately funded fee. Only this digest replaces
// the runtime amount with zero; canonical withdrawal and spender hashes retain it.
export const getWithdrawFeePaymentAuthorizationHash = (
  chainId: number,
  allocator: Address,
  request: WithdrawRequest,
  withdrawFeePayment: WithdrawFeePayment,
  expiration: bigint
) =>
  hashTypedData({
    domain: {
      name: "RelayAllocator",
      version: "1",
      chainId,
      verifyingContract: allocator,
    },
    types: withdrawFeePaymentAuthorizationTypes,
    primaryType: "WithdrawFeePaymentAuthorization",
    message: {
      expiration,
      request: { ...encodeRequest(request), amount: 0n },
      withdrawFeePayment: {
        ...withdrawFeePayment,
        maxAmount: BigInt(withdrawFeePayment.maxAmount),
      },
    },
  })
