import networks from "@relay-settlement/networks"
import { HardhatRuntimeEnvironment } from "hardhat/types"

export function getWNEARAddress(chainId: bigint): string {
  const networkConfig = networks[chainId.toString()]
  if (!networkConfig?.assets?.wNEAR) {
    throw new Error(`No wNEAR address configured for chain ID ${chainId}`)
  }
  return networkConfig.assets.wNEAR
}

export async function checkAndApproveWNEAR(
  hre: HardhatRuntimeEnvironment,
  from: string,
  to: string,
  allowance: bigint = 1n
) {
  const networkChainId = BigInt(hre.network.config.chainId!)
  const wNEARAddress = getWNEARAddress(networkChainId)
  const publicClient = await hre.viem.getPublicClient()

  const wNEAR = await hre.viem.getContractAt("MyToken", wNEARAddress)
  const currentAllowance = await wNEAR.read.allowance([from, to])

  if (currentAllowance < allowance) {
    console.log(`Current wNEAR allowance: ${currentAllowance}`)
    console.log(`Approving ${allowance} wNEAR for ${to}...`)
    const approveHash = await wNEAR.write.approve([to, allowance])
    await publicClient.waitForTransactionReceipt({ hash: approveHash })

    const newAllowance = await wNEAR.read.allowance([from, to])
    console.log("New allowance:", newAllowance)
  }

  return currentAllowance
}
