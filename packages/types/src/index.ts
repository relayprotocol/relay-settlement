/**
 * Type definitions for the Relay Protocol Hub utilities
 */

export type ChainType = 'evm' | 'bitcoin' | 'solana'

export interface TokenIdComponents {
  family: ChainType
  chainId: number
  address: string
}

export type TokenId = BigInt
