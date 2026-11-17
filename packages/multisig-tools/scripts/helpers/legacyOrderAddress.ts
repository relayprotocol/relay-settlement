import {
  Address,
  Hex,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
} from "viem"
import { encodeAddressToHex, VmType } from "@relay-protocol/settlement-sdk"

export type LegacyOrderAddressParams = {
  vmType: VmType
  chainId: string
  depositor: string
  timestamp: bigint
  depositId: string
}

/**
 * Computes a legacy order address from the depositor and deposit timestamp.
 *
 * The oracle no longer credits deposits to these addresses (it uses the SDK's
 * `getOrderAddress`, keyed on chain and deposit id only), but balances credited
 * under the earlier scheme still sit at them, so recovery scripts derive both.
 */
export function getLegacyOrderAddress(
  params: LegacyOrderAddressParams
): Address {
  const hash = keccak256(
    encodeAbiParameters(parseAbiParameters("string, bytes, uint256, bytes32"), [
      params.chainId,
      encodeAddressToHex(params.depositor, params.vmType),
      params.timestamp,
      params.depositId as Hex,
    ])
  )

  // Get 40 bytes for an address
  return `0x${hash.slice(-40)}`
}
