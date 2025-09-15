import { task } from 'hardhat/config'
import { formatUnits } from 'viem'
import { getWNEARAddress } from '../../lib/aurora'

task('allocator:withdraw-to-near', 'Withdraw balance to NEAR')
  .addParam('allocator', 'The address of the allocator contract')
  .addOptionalParam('amount', 'The amount of wNEAR to withdraw')
  .setAction(async ({ allocator: allocatorAddress, amount }, hre) => {
    const { viem, network } = hre
    const publicClient = await viem.getPublicClient()
    const wNEARAddress = await getWNEARAddress(network.config.chainId!)

    const allocator = await viem.getContractAt('Allocator', allocatorAddress)

    const wNEAR = await viem.getContractAt('MyToken', wNEARAddress)

    // check wNEAR balance
    const allocatorBalance = await wNEAR.read.balanceOf([allocator.address])
    console.log(
      `Allocator wNEAR balance: ${formatUnits(allocatorBalance, 24)} wNEAR`
    )

    // remove 1 yNEAR to pay for Aurora call
    const amountToWithdraw = (BigInt(amount) || allocatorBalance) - 1n
    console.log(`Withdrawing ${formatUnits(amountToWithdraw, 24)} to NEAR...`)
    // Call init function
    const withdrawalHash = await allocator.write.withdrawToNear([
      amountToWithdraw,
    ])
    await publicClient.waitForTransactionReceipt({ hash: withdrawalHash })
    console.log(`Amount withdraw successfully: ${withdrawalHash}`)
  })
