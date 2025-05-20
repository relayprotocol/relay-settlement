/**
 * Type definitions for the Relay Protocol Hub utilities
 */
import { ChainType } from './networks'

export interface TokenIdComponents {
  family: ChainType
  chainId: number
  address: string
}

export interface VirtualAddressComponents {
  chainId: number
  address: string
}

export type TokenId = bigint
export type VirtualAddress = `0x${string}`
