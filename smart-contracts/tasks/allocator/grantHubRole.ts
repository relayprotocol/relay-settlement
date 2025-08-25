import { task } from 'hardhat/config'
import { keccak256 } from 'viem'

task(
  'allocator:grant-withdrawer-role',
  'Grant APPROVED_WITHDRAWER_ROLE to an address'
)
  .addParam('allocator', 'The address of the Allocator contract')
  .addOptionalParam(
    'account',
    'The address to grant the APPROVED_WITHDRAWER_ROLE to'
  )
  .setAction(async ({ allocator: allocatorAddress, account }, { viem }) => {
    const [admin] = await viem.getWalletClients()
    const publicClient = await viem.getPublicClient()

    const allocator = await viem.getContractAt('Allocator', allocatorAddress)
    if (!account) {
      account = admin.account.address
    }
    const APPROVED_WITHDRAWER_ROLE = keccak256(
      'APPROVED_WITHDRAWER_ROLE' as `0x${string}`
    )

    const hasRole = await allocator.read.hasRole([
      APPROVED_WITHDRAWER_ROLE,
      account,
    ])
    if (!hasRole) {
      console.log(
        `Granting APPROVED_WITHDRAWER_ROLE ${APPROVED_WITHDRAWER_ROLE} to ${account} ...`
      )
      const tx = await allocator.write.grantRole([
        APPROVED_WITHDRAWER_ROLE,
        account,
      ])
      console.log(`Transaction hash: ${tx}`)
      await publicClient.waitForTransactionReceipt({
        hash: tx,
      })
      console.log(`APPROVED_WITHDRAWER_ROLE granted to ${account}`)
    }
  })
