import { task } from 'hardhat/config'
import { decodeEventLog, zeroAddress } from 'viem'

task('allocator:submit-withdraw', 'Submit withdraw request to allocator')
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('chainId', 'The chain id of the destination address')
  .addParam('escrow', 'The escrow contract on destination chain')
  .addOptionalParam('currency', 'default to zero', zeroAddress)
  .addOptionalParam('amount', 'Amount to withdraw')
  .addOptionalParam('receiver', 'account to receive tokens (default to signer)')
  .addOptionalParam('data', 'additional data', '0x')
  .setAction(
    async (
      {
        allocator: allocatorAddress,
        chainId,
        escrow,
        currency,
        amount = '1', // Default to '1' if not provided
        receiver,
        data,
      },
      { viem }
    ) => {
      const [signer] = await viem.getWalletClients()
      const publicClient = await viem.getPublicClient()

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)
      const wNEARAddress = await allocator.read.wNEAR()
      const wNEAR = await viem.getContractAt('MyToken', wNEARAddress)

      // check wNEAR approval amount
      const allowance = 1n
      const currentAllowance = (await wNEAR.read.allowance([
        signer.account.address,
        allocator.address,
      ])) as bigint
      console.log(`Current wNEAR allowance: ${currentAllowance}`)
      if (currentAllowance < allowance) {
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

      const submitWithdrawRequestParams = [
        chainId,
        escrow,
        currency,
        amount,
        receiver || signer.account.address,
        data,
      ]
      console.log(
        `Submitting withdraw request with params ${submitWithdrawRequestParams.join()}`
      )
      const txHash = await allocator.write.submitWithdrawRequest(
        submitWithdrawRequestParams,
        {
          account: signer.account,
        }
      )

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      console.log('Transaction hash:', receipt.transactionHash)

      const payloadBuiltEvent = receipt.logs.find((log) => {
        try {
          const decodedEvent = decodeEventLog({
            abi: allocator.abi,
            data: log.data,
            eventName: 'PayloadBuilt',
            topics: log.topics,
          })
          return decodedEvent
        } catch {
          return null // Ignore unrecognized events
        }
      })

      if (!payloadBuiltEvent) {
        console.log('PayloadBuilt event not found in transaction logs.')
        return // Exit or handle the missing event scenario
      }

      const { payloadId } = payloadBuiltEvent.args
      console.log(`payloadId: ${payloadId}`)
      console.log('Withdraw request submitted successfully')
    }
  )
