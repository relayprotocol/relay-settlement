import { ethers } from 'ethers'
import { TokenIdComponents } from '@relay-protocol/types'

export const getCheckSummedAddress = (family: string, address: string) => {
  const checksummedAddress =
    family === 'evm' ? ethers.getAddress(address) : address
  return checksummedAddress
}

export const getPackedData = (components: TokenIdComponents) => {
  const { family, chainId, address } = components
  const packedData = ethers.solidityPacked(
    ['string', 'uint256', family === 'evm' ? 'address' : 'string'],
    [family, chainId, getCheckSummedAddress(family, address)]
  )
  return packedData
}
