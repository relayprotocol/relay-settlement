import { task } from 'hardhat/config'
import { parseUnits } from 'viem'
import { checkAndApproveWNEAR, getWNEARAddress } from '../../lib/aurora'

task('allocator:init', 'Initialize the Allocator contract')
  .addParam('allocator', 'The address of the allocator contract')
  .addOptionalParam('wNEAR', 'The address of the wNEAR contract')
  .setAction(
    async ({ allocator: allocatorAddress, wNEAR: wNEARAddress }, hre) => {
      const { viem, network } = hre
      const [signer] = await viem.getWalletClients()
      const publicClient = await viem.getPublicClient()

      if (!wNEARAddress) {
        wNEARAddress = await getWNEARAddress(network.config.chainId!)
      }

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)

      // Approve 2 wNEAR for the allocator if necessary
      const allowance = parseUnits('2', 24)
      await checkAndApproveWNEAR(
        hre,
        publicClient,
        signer.account.address,
        allocator.address,
        allowance
      )

      // check wNEAR balance
      const wNEAR = await viem.getContractAt('MyToken', wNEARAddress)
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
  )
