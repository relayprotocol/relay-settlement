import { task } from 'hardhat/config'
import { parseUnits } from 'viem'

task('allocator:sign-payload', 'Sign payload on allocator')
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('payloadId', 'The payloadId to use')
  .addParam('chainId', 'The chainId on which the withdrawal will be made')
  .addParam('escrow', 'The escrow contract address from which to withdraw')
  .addParam('wnear', 'The address of the wNEAR contract')
  .setAction(
    async (
      {
        allocator: allocatorAddress,
        payloadId,
        escrow,
        chainId,
        wnear: wNEARAddress,
      },
      { viem }
    ) => {
      const [signer] = await viem.getWalletClients()
      const publicClient = await viem.getPublicClient()

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)
      const wNEAR = await viem.getContractAt('MyToken', wNEARAddress)

      // check wNEAR approval amount
      const allowance = parseUnits('1', 24)
      const currentAllowance = (await wNEAR.read.allowance([
        signer.account.address,
        allocator.address,
      ])) as bigint
      if (currentAllowance < allowance) {
        console.log(`Current wNEAR allowance: ${currentAllowance}`)
        console.log('Approving 1 wNEAR for allocator...')
        const approveHash = await wNEAR.write.approve([
          allocator.address,
          allowance,
        ])
        await publicClient.waitForTransactionReceipt({ hash: approveHash })
        console.log(
          'New signer allowance:',
          await wNEAR.read.allowance([
            signer.account.address,
            allocator.address,
          ])
        )
      }

      console.log(`Signing payload for hash: ${payloadId}`)
      const txHash = await allocator.write.signWithdrawPayload(
        [chainId, escrow, payloadId],
        {
          account: signer.account,
        }
      )

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      console.log('Signing Transaction:', receipt.transactionHash)
    }
  )
