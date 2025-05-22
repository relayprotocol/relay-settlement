import { task } from 'hardhat/config'

task(
  'allocator:set-payload-builder',
  'Set a payload builder for a specific chain and escrow'
)
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('chainId', 'The chain ID where the payload builder will be used')
  .addParam('escrow', 'The address of the escrow contract')
  .addParam('builder', 'The address of the payload builder contract')
  .setAction(
    async (
      { allocator: allocatorAddress, chainId, escrow, builder },
      { viem }
    ) => {
      const [signer] = await viem.getWalletClients()
      const publicClient = await viem.getPublicClient()

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)

      console.log('Setting payload builder...')
      console.log(`Chain ID: ${chainId}`)
      console.log(`Escrow: ${escrow}`)
      console.log(`Builder: ${builder}`)

      const txHash = await allocator.write.setPayloadBuilder(
        [BigInt(chainId), escrow, builder],
        {
          account: signer.account,
        }
      )

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      console.log('Transaction hash:', receipt.transactionHash)
      console.log('Payload builder set successfully')
    }
  )
