import { task } from 'hardhat/config'
import { parseUnits } from 'viem'
import { checkAndApproveWNEAR, getWNEARAddress } from '../../lib/aurora'

task('allocator:sign-payload', 'Sign payload on allocator')
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('payloadId', 'The payloadId to use')
  .addParam('chainId', 'The chainId on which the withdrawal will be made')
  .addParam(
    'depository',
    'The depository contract address from which to withdraw'
  )
  .addOptionalParam('wnear', 'The address of the wNEAR contract')
  .setAction(
    async (
      { allocator: allocatorAddress, payloadId, wnear: wNEARAddress },
      hre
    ) => {
      const { viem, network } = hre
      const [signer] = await viem.getWalletClients()
      const publicClient = await viem.getPublicClient()

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)

      if (!wNEARAddress) {
        wNEARAddress = await getWNEARAddress(network.config.chainId!)
      }

      // check wNEAR approval amount
      const allowance = parseUnits('1', 24)
      await checkAndApproveWNEAR(
        hre,
        publicClient,
        signer.account.address,
        allocator.address,
        allowance
      )

      console.log(`Signing payload for hash: ${payloadId}`)
      const txHash = await allocator.write.signWithdrawPayload(
        [
          payloadId,
          '0x',
          {
            callbackGas: 30_000_000_000_000n,
            signGas: 10_000_000_000_000n,
          },
        ],
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
