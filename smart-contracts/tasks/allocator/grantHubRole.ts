import { task } from 'hardhat/config'
import { keccak256 } from 'viem'

task('allocator:hub-role', 'Grant HUB_ROLE to an address')
  .addParam('allocator', 'The address of the Allocator contract')
  .addOptionalParam('account', 'The address to grant the HUB_ROLE to')
  .setAction(async ({ allocator, account }, { viem }) => {
    const [admin] = await viem.getWalletClients()
    const allocatorContract = await viem.getContractAt('Allocator', allocator)
    if (!account) {
      account = admin.account.address
    }
    const HUB_ROLE = keccak256('HUB_ROLE' as `0x${string}`)
    console.log(`Granting HUB_ROLE ${HUB_ROLE} to ${account} ...`)
    const tx = await allocatorContract.write.grantRole([HUB_ROLE, account], {
      account: admin.account,
    })

    console.log(`Transaction hash: ${tx}`)
    console.log(`HUB_ROLE granted to ${account}`)
  })
