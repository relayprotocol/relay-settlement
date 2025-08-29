import networks from '@relay-protocol/networks'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { PublicClient } from 'viem'

export function getWNEARAddress(chainId: bigint): string {
  const networkConfig = networks[chainId.toString()]
  if (!networkConfig?.assets?.wNEAR) {
    throw new Error(`No wNEAR address configured for chain ID ${chainId}`)
  }
  return networkConfig.assets.wNEAR
}

export async function checkAndApproveWNEAR(
  hre: HardhatRuntimeEnvironment,
  publicClient: PublicClient,
  from: string,
  to: string,
  allowance: bigint = 1n
) {
  const networkChainId = BigInt(hre.network.config.chainId!)
  const wNEARAddress = getWNEARAddress(networkChainId)

  const wNEAR = await hre.viem.getContractAt('MyToken', wNEARAddress)
  const currentAllowance = await wNEAR.read.allowance([from, to])

  if (currentAllowance < allowance) {
    console.log(`Current wNEAR allowance: ${currentAllowance}`)
    console.log(`Approving ${allowance} wNEAR for allocator...`)
    const approveHash = await wNEAR.write.approve([to, allowance])
    await publicClient.waitForTransactionReceipt({ hash: approveHash })

    const newAllowance = await wNEAR.read.allowance([from, to])
    console.log('New allowance:', newAllowance)
  }

  return currentAllowance
}
