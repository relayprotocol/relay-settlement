import { task } from 'hardhat/config'
import { decodeEventLog, zeroAddress } from 'viem'

task('allocator:submit-withdraw', 'Submit withdraw request to allocator')
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('chainId', 'The chain id of the destination address')
  .addParam('escrow', 'The escrow contract on destination chain')
  .addOptionalParam('currency', 'default to zero', zeroAddress)
  .addOptionalParam('amount', 'Amount to withdraw', '1')
  .addOptionalParam('receiver', 'account to receive tokens (default to signer)')
  .addOptionalParam('data', 'additional data', '0x')
  .setAction(
    async (
      {
        allocator: allocatorAddress,
        chainId,
        escrow,
        currency,
        amount,
        receiver,
        data,
      },
      { viem }
    ) => {
      const [signer] = await viem.getWalletClients()
      const publicClient = await viem.getPublicClient()

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)

      const submitWithdrawRequestParams = [
        chainId,
        escrow,
        currency,
        amount,
        receiver || signer.account.address,
        data,
      ]
      console.log('Submitting withdraw request with params', {
        amount,
        chainId,
        currency,
        data,
        escrow,
        receiver: receiver || signer.account.address,
      })
      const txHash = await allocator.write.submitWithdrawRequest(
        submitWithdrawRequestParams,
        {
          account: signer.account,
        }
      )
      console.log('Withdraw Request Transaction:', txHash)

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      const [payloadBuiltEvent] = receipt.logs
        .map((log) => {
          try {
            return decodeEventLog({
              abi: allocator.abi,
              data: log.data,
              eventName: 'PayloadBuilt',
              topics: log.topics,
            })
          } catch {
            return null // or filter out unrecognized events
          }
        })
        .filter((e) => e !== null)

      if (!payloadBuiltEvent) {
        console.log('PayloadBuilt event not found in transaction logs.')
        return // Exit or handle the missing event scenario
      }

      const { payloadId } = payloadBuiltEvent.args
      console.log(`payloadId: ${payloadId}`)
      return payloadId
    }
  )
