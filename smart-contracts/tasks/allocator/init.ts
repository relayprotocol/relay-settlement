import { task } from 'hardhat/config'
import { formatUnits, parseUnits } from 'viem'
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
        signer.account.address,
        allocator.address,
        allowance
      )

      const wNEAR = await viem.getContractAt('MyToken', wNEARAddress)
      // check wNEAR balance
      const userBalance = await wNEAR.read.balanceOf([signer.account.address])
      console.log(
        `Current user wNEAR balance: ${formatUnits(userBalance, 24)} wNEAR`
      )
      console.log(formatUnits(2000000000000000000000000n, 24))

      const allocatorBalance = await wNEAR.read.balanceOf([allocator.address])
      console.log(
        `Current allocator wNEAR balance: ${formatUnits(allocatorBalance, 24)} wNEAR`
      )

      console.log('Initializing Allocator (and funding it!)...')
      // Call init function
      const initHash = await allocator.write.init()
      await publicClient.waitForTransactionReceipt({ hash: initHash })
      console.log('Allocator initialized successfully')
    }
  )
