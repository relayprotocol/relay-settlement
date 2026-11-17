import { Address, Hex, hashTypedData } from "viem"

import { WithdrawRequest } from "../v2.3/withdrawal"
import { Authorization } from "./authorization"

export type WithdrawRequestAuthorization = {
  withdrawRequest: WithdrawRequest
  authorization: Authorization
}

// `RelayAllocator.submitWithdrawRequestWithSignature`: the spender (or the
// oracle multisig for non-EVM spenders) signs the normalized request together
// with the last Unix second the signature is valid for
export type WithdrawRequestAuthorizationMessage = {
  request: WithdrawRequest
  expiration: bigint
}

// Field order is part of `WITHDRAW_REQUEST_AUTHORIZATION_TYPEHASH`; the referenced
// `WithdrawRequest` type follows the primary type as EIP-712 requires
export const withdrawRequestAuthorizationTypes = {
  WithdrawRequestAuthorization: [
    { name: "request", type: "WithdrawRequest" },
    { name: "expiration", type: "uint256" },
  ],
  WithdrawRequest: [
    { name: "chainId", type: "string" },
    { name: "depository", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "amount", type: "uint256" },
    { name: "spenderChainId", type: "string" },
    { name: "spender", type: "bytes" },
    { name: "receiver", type: "bytes" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "bytes32" },
  ],
} as const

/**
 * The EIP-712 typed data of a withdraw authorization, ready to sign with `signTypedData`.
 * @param chainId Relay chain id
 * @param allocator `RelayAllocator` address
 * @param authorization The normalized request and the signature's expiration
 */
export const getWithdrawRequestAuthorizationTypedData = (
  chainId: number,
  allocator: Address,
  authorization: WithdrawRequestAuthorizationMessage
) =>
  ({
    domain: {
      name: "RelayAllocator",
      version: "1",
      chainId,
      verifyingContract: allocator,
    },
    types: withdrawRequestAuthorizationTypes,
    primaryType: "WithdrawRequestAuthorization",
    message: {
      request: {
        chainId: authorization.request.chainId,
        depository: authorization.request.depository as Hex,
        currency: authorization.request.currency as Hex,
        amount: BigInt(authorization.request.amount),
        spenderChainId: authorization.request.spenderChainId,
        spender: authorization.request.spender as Hex,
        receiver: authorization.request.receiver as Hex,
        data: authorization.request.data as Hex,
        nonce: authorization.request.nonce as Hex,
      },
      expiration: authorization.expiration,
    },
  }) as const

/**
 * The digest `RelayAllocator` recovers the spender from, or has the oracle multisig validate.
 * Mirrors `RelayAllocator.hashWithdrawRequestAuthorization`.
 * @param chainId Relay chain id
 * @param allocator `RelayAllocator` address
 * @param authorization The normalized request and the signature's expiration
 */
export const getWithdrawRequestAuthorizationHash = (
  chainId: number,
  allocator: Address,
  authorization: WithdrawRequestAuthorizationMessage
): Hex =>
  hashTypedData(
    getWithdrawRequestAuthorizationTypedData(chainId, allocator, authorization)
  )
