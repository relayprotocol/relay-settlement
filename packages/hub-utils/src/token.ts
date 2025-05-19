import { ethers } from 'ethers'
import { TokenIdComponents, TokenId } from '@relay-protocol/types'
import { getPackedData } from './utils'
/**
 * Generates a token ID based on the chain type, chain ID, and address
 * @param components The token components (family, chainId, address)
 * @returns The keccak256 hash of the token components
 */
export function generateTokenId(components: TokenIdComponents): TokenId {
  const packedData = getPackedData(components)
  return BigInt(ethers.keccak256(packedData))
}
