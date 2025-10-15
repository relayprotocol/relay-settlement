/**
 * Type definitions for the Relay Protocol Hub utilities
 */
import { VmType } from "@reservoir0x/relay-protocol-sdk"

export interface TokenIdComponents {
  family: VmType
  chainId: bigint
  address: string
}

export interface VirtualAddressComponents {
  family: VmType
  chainId: bigint
  address: string
}

export type TokenId = bigint
export type VirtualAddress = `0x${string}`
