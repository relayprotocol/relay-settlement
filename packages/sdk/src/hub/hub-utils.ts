import { Address, getAddress, keccak256, encodePacked, Hex } from "viem"

import { encodeAddress, VmType } from "../utils"

export interface TokenIdComponents {
  family: VmType
  chainId: string
  address: string
}

export interface VirtualAddressComponents {
  family: VmType
  chainId: string
  address: string
}

export type TokenId = bigint
export type VirtualAddress = Address

export const arrayToHex = (arr: Uint8Array): Hex =>
  `0x${Buffer.from(arr).toString("hex")}`

const HYPERLIQUID_ACCOUNT_BYTES = 20
const HYPERLIQUID_CURRENCY_BYTES = 16

const encodeHubField = (
  address: string,
  family: VmType,
  hyperliquidBytes: number
): Hex => {
  const encoded = encodeAddress(address, family)
  if (family === "hyperliquid-vm" && encoded.length !== hyperliquidBytes) {
    throw new Error(
      `Invalid hyperliquid-vm byte length ${encoded.length}; expected ${hyperliquidBytes}`
    )
  }
  return arrayToHex(encoded)
}

/**
 * Generates a virtual Ethereum address from token components
 * @param components The token components (family, chainId, address)
 * @returns A checksummed Ethereum address derived from the token ID
 * @remarks This function first generates a token ID using the components,
 * then converts the last 20 bytes of the hash to an Ethereum address.
 * This is equivalent to the Solidity: address(uint160(uint256(addressHash)))
 */
export function generateAddress(
  components: VirtualAddressComponents
): VirtualAddress {
  const { chainId, address, family } = components
  const addressHash = keccak256(
    encodePacked(
      ["string", "bytes"],
      [chainId, encodeHubField(address, family, HYPERLIQUID_ACCOUNT_BYTES)]
    )
  )
  const addressBytes = addressHash.slice(2).slice(-40)
  return getAddress("0x" + addressBytes) as `0x${string}`
}

/**
 * Generates a token ID based on the chain type, chain ID, and address
 * @param components The token components (family, chainId, address)
 * @returns The keccak256 hash of the token components
 */
export function generateTokenId(components: TokenIdComponents): TokenId {
  const { family, chainId, address } = components
  const packedData = encodePacked(
    ["string", "bytes"],
    [chainId, encodeHubField(address, family, HYPERLIQUID_CURRENCY_BYTES)]
  )
  return BigInt(keccak256(packedData))
}
