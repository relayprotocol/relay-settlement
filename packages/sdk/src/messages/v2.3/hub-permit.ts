import { Address, Hex, hashTypedData, parseSignature } from "viem"

// `RelayHub.permit`: an EIP-712 permit, under the Hub's own domain, that sets
// a spender's allowance on one of the owner's Hub token balances. Replay
// protection is the Hub's per-owner `nonces(owner)`, consumed by every permit.
// `FundingPool.depositFromWithPermit` relays one together with the pull, so an
// account that only signs (a KMS key, a multisig's signer) never sends.
export type HubPermit = {
  owner: Address
  spender: Address
  tokenId: bigint
  value: bigint
  // Current `RelayHub.nonces(owner)`
  nonce: bigint
  // Unix seconds after which the Hub rejects the permit
  deadline: bigint
}

export const hubPermitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

/**
 * The EIP-712 typed data of a Hub permit, ready to sign with `signTypedData`.
 * @param chainId Hub chain id
 * @param hub Hub contract address
 * @param permit The permit fields
 */
export const getHubPermitTypedData = (
  chainId: number,
  hub: Address,
  permit: HubPermit
) =>
  ({
    domain: { name: "RelayHub", version: "1", chainId, verifyingContract: hub },
    types: hubPermitTypes,
    primaryType: "Permit",
    message: permit,
  }) as const

/**
 * The digest the Hub recovers a permit's signer from.
 * @param chainId Hub chain id
 * @param hub Hub contract address
 * @param permit The permit fields
 */
export const getHubPermitHash = (
  chainId: number,
  hub: Address,
  permit: HubPermit
): Hex => hashTypedData(getHubPermitTypedData(chainId, hub, permit))

/**
 * The `v`, `r`, `s` that `RelayHub.permit` takes, from a signature as `signTypedData` returns it.
 * Validates the shape and normalizes a 0/1 recovery id to 27/28; a malformed signature throws.
 * @param signature 65-byte signature, or a 64-byte EIP-2098 compact one
 */
export const splitHubPermitSignature = (
  signature: Hex
): { v: number; r: Hex; s: Hex } => {
  const { r, s, v, yParity } = parseSignature(signature)
  return { r, s, v: v !== undefined ? Number(v) : (yParity ?? 0) + 27 }
}
