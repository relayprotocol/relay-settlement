import { ethers } from 'ethers'

export const getIntentAddress = (intentId: string) => {
  const addressHash = ethers.keccak256(
    ethers.solidityPacked(['string'], [intentId])
  )
  return ethers.getAddress('0x' + addressHash.slice(2).slice(-40))
}
