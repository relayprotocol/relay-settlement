import hre from 'hardhat'
export const DEFAULT_DELAY = 600n

export async function deployAllocator(options?: {
  owner?: `0x${string}`
  delay?: bigint
}) {
  const [owner, ...otherAccounts] = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()

  // deploy wNear
  const wNEAR = await hre.viem.deployContract('MyToken')

  //depoloy libs
  const auroraXccUtils = await hre.viem.deployContract('AuroraXccUtils')
  const codec = await hre.viem.deployContract('Codec')
  const auroraSdk = await hre.viem.deployContract('AuroraSdk', [], {
    libraries: {
      AuroraXccUtils: auroraXccUtils.address,
      Codec: codec.address,
    },
  })
  const allocatorParams = [
    options?.owner ?? owner.account.address, // owner
    options?.delay ?? DEFAULT_DELAY, // delay
    'v1.signer.test', // signer
    wNEAR.address,
  ]

  const allocator = await hre.viem.deployContract(
    'Allocator',
    allocatorParams,
    {
      libraries: {
        AuroraSdk: auroraSdk.address,
      },
    }
  )

  return {
    allocator,
    otherAccounts,
    owner,
    publicClient,
    wNEAR,
  }
}
