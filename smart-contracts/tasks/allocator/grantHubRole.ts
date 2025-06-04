import { task } from 'hardhat/config'
import { keccak256 } from 'viem'

task('allocator:grant-hub-role', 'Grant HUB_ROLE to an address')
  .addParam('allocator', 'The address of the Allocator contract')
  .addOptionalParam('account', 'The address to grant the HUB_ROLE to')
  .setAction(async ({ allocator: allocatorAddress, account }, { viem }) => {
    const [admin] = await viem.getWalletClients()
    const publicClient = await viem.getPublicClient()

    const allocator = await viem.getContractAt('Allocator', allocatorAddress)
    if (!account) {
      account = admin.account.address
    }
    const HUB_ROLE = keccak256('HUB_ROLE' as `0x${string}`)

    const hasRole = await allocator.read.hasRole([HUB_ROLE, account])
    if (!hasRole) {
      console.log(`Granting HUB_ROLE ${HUB_ROLE} to ${account} ...`)
      const tx = await allocator.write.grantRole([HUB_ROLE, account])
      console.log(`Transaction hash: ${tx}`)
      await publicClient.waitForTransactionReceipt({
        hash: tx,
      })
      console.log(`HUB_ROLE granted to ${account}`)
    }
  })
