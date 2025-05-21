import hre from 'hardhat'
import AllocatorModule from '../../ignition/modules/Allocator'

export const DEFAULT_DELAY = 600n

export async function deployAllocator(options?: {
  owner?: `0x${string}`
  delay?: bigint
}) {
  const [owner, ...otherAccounts] = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()

  const { allocator } = await hre.ignition.deploy(AllocatorModule, {
    parameters: {
      Allocator: {
        delay: options?.delay ?? DEFAULT_DELAY,
        owner: options?.owner ?? owner.account.address,
      },
    },
  })

  return {
    allocator,
    otherAccounts,
    owner,
    publicClient,
  }
}
