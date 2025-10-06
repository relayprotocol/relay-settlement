import { task } from 'hardhat/config'
import { keccak256 } from 'viem'

task('hub:add-operator', 'Grant OPERATOR_ROLE to an address')
  .addParam('hub', 'The address of the Hub contract')
  .addOptionalParam('account', 'The address to grant the OPERATOR_ROLE to')
  .setAction(async ({ hub: hubAddress, account }, { viem }) => {
    const [admin] = await viem.getWalletClients()
    const publicClient = await viem.getPublicClient()

    const hub = await viem.getContractAt('Hub', hubAddress)
    if (!account) {
      account = admin.account.address
    }
    const OPERATOR_ROLE = keccak256('OPERATOR_ROLE' as `0x${string}`)

    const hasRole = await hub.read.hasRole([OPERATOR_ROLE, account])
    if (!hasRole) {
      console.log(`Granting OPERATOR_ROLE ${OPERATOR_ROLE} to ${account} ...`)
      const tx = await hub.write.grantRole([OPERATOR_ROLE, account])
      console.log(`Transaction hash: ${tx}`)
      await publicClient.waitForTransactionReceipt({
        hash: tx,
      })
      console.log(`OPERATOR_ROLE granted to ${account}`)
    }
  })
