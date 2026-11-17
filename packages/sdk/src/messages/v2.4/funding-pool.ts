import { randomBytes } from "@noble/hashes/utils"
import { Address, bytesToBigInt, hashTypedData } from "viem"

// Mirrors `IFundingPool.DrawRevocation`. Sign the current on-chain epoch;
// `nonce` is the account's new draw nonce, between `MIN_DRAW_NONCE_JUMP`
// (2^32) and `MAX_DRAW_NONCE_JUMP` (2^64 - 1) above the current one. Pick it
// at random (`getRandomFundingPoolRevocationNonce`): the authorizer may hold
// signatures for any nonce it can guess, so `current + 1` or any other
// predictable value kills nothing pre-signed
export type FundingPoolDrawRevocation = {
  account: Address
  epoch: bigint
  nonce: bigint
  deadline: bigint
}

// The primary type stays "DrawRevocation" — the on-chain
// `DRAW_REVOCATION_TYPEHASH` is derived from the Solidity struct name
export const fundingPoolDrawRevocationTypes = {
  DrawRevocation: [
    { name: "account", type: "address" },
    { name: "epoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

// Mirrors `FundingPool.hashDrawRevocation`
export const getFundingPoolDrawRevocationHash = (
  chainId: number,
  pool: Address,
  revocation: FundingPoolDrawRevocation
) =>
  hashTypedData({
    domain: {
      name: "FundingPool",
      version: "1",
      chainId,
      verifyingContract: pool,
    },
    types: fundingPoolDrawRevocationTypes,
    primaryType: "DrawRevocation",
    message: revocation,
  })

// Mirrors `FundingPool.MIN_DRAW_NONCE_JUMP` / `MAX_DRAW_NONCE_JUMP`: the
// pool checks `MIN <= target - drawNonces(account) <= MAX` when the
// revocation executes, not when it is signed
export const MIN_FUNDING_POOL_REVOCATION_JUMP = 1n << 32n
export const MAX_FUNDING_POOL_REVOCATION_JUMP = (1n << 64n) - 1n

// Lower bound of the jumps `getRandomFundingPoolRevocationNonce` draws: twice
// the pool's minimum, so a signed revocation keeps at least 2^32 queued
// signed updates of slack before its remaining gap falls under the minimum
export const MIN_RANDOM_FUNDING_POOL_REVOCATION_JUMP =
  2n * MIN_FUNDING_POOL_REVOCATION_JUMP

// A revocation nonce `currentNonce + jump` with a random `jump` in
// [2 * MIN, MAX]. Always use this (or another CSPRNG) for the revocation
// nonce: a predictable jump is one the authorizer can have pre-signed a draw
// for. Pass the nonce read right before signing; the pool measures the jump
// from the nonce current when the revocation executes
export const getRandomFundingPoolRevocationNonce = (
  currentNonce: bigint
): bigint => {
  const range =
    MAX_FUNDING_POOL_REVOCATION_JUMP -
    MIN_RANDOM_FUNDING_POOL_REVOCATION_JUMP +
    1n
  const jump =
    MIN_RANDOM_FUNDING_POOL_REVOCATION_JUMP +
    (bytesToBigInt(randomBytes(8)) % range)
  return currentNonce + jump
}
