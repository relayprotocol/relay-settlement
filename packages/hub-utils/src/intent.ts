import { ethers } from "ethers"
import { VirtualAddress } from "@relay-settlement/types"

export const generateIntentAddress = (intentId: string): VirtualAddress => {
  const addressHash = ethers.keccak256(
    ethers.solidityPacked(["string"], [intentId])
  )
  return ethers.getAddress(
    "0x" + addressHash.slice(2).slice(-40)
  ) as `0x${string}`
}
