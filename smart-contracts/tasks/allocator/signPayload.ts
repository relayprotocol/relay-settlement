import { task } from 'hardhat/config'
import { parseUnits, zeroAddress } from 'viem'
import { checkAndApproveWNEAR, getWNEARAddress } from '../../lib/aurora'

task('allocator:sign-payload', 'Sign payload on allocator')
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('chainId', 'The chain id of the destination address')
  .addParam('depository', 'The depository contract on destination chain')
  .addParam('nonce', 'The nonce for the request submitted earlier')
  .addOptionalParam('currency', 'default to zero', zeroAddress)
  .addOptionalParam('amount', 'Amount to withdraw', '1')
  .addOptionalParam('receiver', 'account to receive tokens (default to signer)')
  .addOptionalParam('data', 'additional data', '0x')
  .addOptionalParam('wnear', 'The address of the wNEAR contract')
  .setAction(
    async (
      {
        allocator: allocatorAddress,
        chainId,
        depository,
        currency,
        amount,
        receiver,
        data,
        wnear: wNEARAddress,
        nonce,
      },
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

      const submitWithdrawRequestParams = {
        amount,
        chainId,
        currency,
        data,
        depository,
        nonce,
        receiver: receiver || signer.account.address,
        spender: receiver || signer.account.address,
      }

      console.log('Signing payload', submitWithdrawRequestParams)
      const txHash = await allocator.write.signWithdrawPayload(
        [
          submitWithdrawRequestParams,
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
      console.log(txHash)

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      console.log('Signing Transaction:', receipt.transactionHash)
    }
  )
