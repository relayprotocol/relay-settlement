import { ethers } from "ethers"
import { TokenIdComponents, TokenId } from "@relay-settlement/types"
import { getCheckSummedAddress } from "./utils"

/**
 * Generates a token ID based on the chain type, chain ID, and address
 * @param components The token components (family, chainId, address)
 * @returns The keccak256 hash of the token components
 */
export function generateTokenId(components: TokenIdComponents): TokenId {
  const { family, chainId, address } = components
  const packedData = ethers.solidityPacked(
    ["string", "uint256", family === "ethereum-vm" ? "address" : "string"],
    [family, chainId, getCheckSummedAddress(family, address)]
  )
  return BigInt(ethers.keccak256(packedData))
}
