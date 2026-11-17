import {
  Hex,
  Address,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
} from "viem"

export type OrderAddressParams = {
  chainId: string
  depositId: string
}

/** Computes the order address from the destination chain and deposit ID. */
export function getOrderAddress(orderParams: OrderAddressParams): Address {
  const hash = keccak256(
    encodeAbiParameters(parseAbiParameters("string, bytes32"), [
      orderParams.chainId,
      orderParams.depositId as Hex,
    ])
  )

  // Get 40 bytes for an address
  const orderAddress = hash.slice(2).slice(-40)
  return `0x${orderAddress}`
}
