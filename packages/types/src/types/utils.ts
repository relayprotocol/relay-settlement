/**
 * Type definitions for the Relay Protocol Hub utilities
 */
import { ChainType } from './networks'

export interface TokenIdComponents {
  family: ChainType
  chainId: bigint
  address: string
}

export interface VirtualAddressComponents {
  chainId: bigint
  address: string
}

export type TokenId = bigint
export type VirtualAddress = `0x${string}`
