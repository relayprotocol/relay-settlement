import { Address, Hex, hashTypedData } from "viem"

import { GenericMappingMessage } from "../v2.2/generic-mapping"

// Mirrors `RelayGenericMapping.setEntry`. `expiration` is the last valid Unix
// second for the oracle signature
export type GenericMappingSetEntry = GenericMappingMessage & {
  expiration: bigint
}

// Mirrors `RelayGenericMapping.deleteEntry`
export type GenericMappingDeleteEntry = {
  user: string
  id: string
  nonce: string
  expiration: bigint
}

// Field order is part of `SET_ENTRY_TYPEHASH`
export const genericMappingSetEntryTypes = {
  SetEntry: [
    { name: "user", type: "address" },
    { name: "id", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "bytes32" },
    { name: "expiration", type: "uint256" },
  ],
} as const

// Field order is part of `DELETE_ENTRY_TYPEHASH`
export const genericMappingDeleteEntryTypes = {
  DeleteEntry: [
    { name: "user", type: "address" },
    { name: "id", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiration", type: "uint256" },
  ],
} as const

const genericMappingDomain = (chainId: number, mapping: Address) => ({
  name: "RelayGenericMapping",
  version: "1",
  chainId,
  verifyingContract: mapping,
})

// The EIP-712 digest the oracle signs for `RelayGenericMapping.setEntry`
export const getGenericMappingSetEntryHash = (
  chainId: number,
  mapping: Address,
  entry: GenericMappingSetEntry
) =>
  hashTypedData({
    domain: genericMappingDomain(chainId, mapping),
    types: genericMappingSetEntryTypes,
    primaryType: "SetEntry",
    message: {
      user: entry.user as Address,
      id: entry.id as Hex,
      data: entry.data as Hex,
      nonce: entry.nonce as Hex,
      expiration: entry.expiration,
    },
  })

// The EIP-712 digest the oracle signs for `RelayGenericMapping.deleteEntry`
export const getGenericMappingDeleteEntryHash = (
  chainId: number,
  mapping: Address,
  entry: GenericMappingDeleteEntry
) =>
  hashTypedData({
    domain: genericMappingDomain(chainId, mapping),
    types: genericMappingDeleteEntryTypes,
    primaryType: "DeleteEntry",
    message: {
      user: entry.user as Address,
      id: entry.id as Hex,
      nonce: entry.nonce as Hex,
      expiration: entry.expiration,
    },
  })
