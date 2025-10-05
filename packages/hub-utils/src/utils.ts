import { ethers } from "ethers"

export const getCheckSummedAddress = (family: string, address: string) => {
  const checksummedAddress =
    family === "ethereum-vm" ? ethers.getAddress(address) : address
  return checksummedAddress
}
