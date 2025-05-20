import { ethers } from 'ethers'
import { VirtualAddressComponents, VirtualAddress } from '@relay-protocol/types'

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
  const { chainId, address } = components
  const addressHash = ethers.keccak256(
    ethers.solidityPacked(['uint', 'string'], [chainId, address])
  )
  const addressBytes = addressHash.slice(2).slice(-40)
  return ethers.getAddress('0x' + addressBytes) as `0x${string}`
}
