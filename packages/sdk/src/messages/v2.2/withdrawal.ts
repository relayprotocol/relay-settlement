import {
  Hex,
  Address,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
} from "viem"

import { arrayToHex } from "../../hub/hub-utils"
import { encodeAddress, VmType } from "../../utils"

export type OrderAddressSafeParams = {
  vmType: VmType
  chainId: string
  depositor: string
  timestamp: bigint
  depositId: string
}

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

/**
 * Computes a legacy order address from the depositor and timestamp using abi.encode.
 * Uses encodeAbiParameters instead of encodePacked to prevent hash collisions
 * with variable-length arguments (VIG-SP-014).
 */
export function getOrderAddressSafe(
  orderParams: OrderAddressSafeParams
): Address {
  const hash = keccak256(
    encodeAbiParameters(parseAbiParameters("string, bytes, uint256, bytes32"), [
      orderParams.chainId,
      arrayToHex(encodeAddress(orderParams.depositor, orderParams.vmType)),
      orderParams.timestamp,
      orderParams.depositId as Hex,
    ])
  )

  // Get 40 bytes for an address
  const orderAddress = hash.slice(2).slice(-40)
  return `0x${orderAddress}`
}
