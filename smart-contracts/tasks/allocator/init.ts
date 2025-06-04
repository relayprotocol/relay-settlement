import { task } from 'hardhat/config'
import { parseUnits } from 'viem'

task('allocator:init', 'Initialize the Allocator contract')
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('wNEAR', 'The address of the wNEAR contract')
  .setAction(
    async ({ allocator: allocatorAddress, wNEAR: wNearAddress }, { viem }) => {
      const [signer] = await viem.getWalletClients()
      const publicClient = await viem.getPublicClient()

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)

      const isEnabled = await allocator.read.enabled()
      if (!isEnabled) {
        // Get the wNEAR address from the allocator contract
        const wNEAR = await viem.getContractAt('MyToken', wNearAddress)

        // check wNEAR approval amount
        const currentAllowance = (await wNEAR.read.allowance([
          signer.account.address,
          allocator.address,
        ])) as bigint
        console.log(`Current wNEAR allowance: ${currentAllowance} wei`)

        // Approve 2 wNEAR for the allocator if necessary
        const allowance = parseUnits('2', 24)
        if (currentAllowance < allowance) {
          const approveHash = await wNEAR.write.approve([
            allocator.address,
            allowance,
          ])
          await publicClient.waitForTransactionReceipt({ hash: approveHash })
          console.log('Approved 2 wNEAR for allocator')
        }

        // Check wNEAR balance of the signer
        const nativeBalance = await publicClient.getBalance({
          address: signer.account.address,
        })
        console.log(`Aurora native balance: ${nativeBalance} wei`)

        const balance = await wNEAR.read.balanceOf([signer.account.address])
        console.log(`Current wNEAR balance: ${balance} wei`)

        if (balance < allowance) {
          throw Error(`Insufficient balance ${balance}`)
        }

        // Call init function
        const initHash = await allocator.write.init()
        await publicClient.waitForTransactionReceipt({ hash: initHash })
        console.log('Allocator initialized successfully')
      }
    }
  )
