import { task } from 'hardhat/config'
import {
  createPublicClient,
  createWalletClient,
  extractChain,
  getContract,
  http,
  recoverTypedDataAddress,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'
import { decodeCallRequest, IRelayDespository } from '../../lib/evm'
import { extractNearSignature } from '../../lib/near'

task('depository:withdraw', 'Withdraw from depository')
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('payloadId', 'The payloadId to use')
  .addOptionalParam(
    'payloadBuilderType',
    'The type of the payload builder. (EVMPayloadBuilder, ...)',
    'EVMPayloadBuilder'
  )

  .setAction(
    async (
      { allocator: allocatorAddress, payloadId, payloadBuilderType },
      hre
    ) => {
      const { viem } = hre

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)
      const [withdrawParams, rawPayload] = await allocator.read.payloads([
        payloadId,
      ])

      const payloadBuilderAddress = await allocator.read.payloadBuilders([
        withdrawParams.chainId,
        withdrawParams.depository,
      ])

      // get the signed payload
      const payloadBuilder = await viem.getContractAt(
        payloadBuilderType,
        payloadBuilderAddress
      )
      const payloadHashes: string[] = (await payloadBuilder.read.hashesToSign([
        withdrawParams.chainId,
        withdrawParams.depository,
        rawPayload as `0x${string}`,
      ])) as string[]

      const signedPayloads: Record<
        string,
        { r: string; s: string; v: number }
      > = {}
      for (let i = 0; i < payloadHashes.length; i++) {
        const hash = payloadHashes[i]
        const signature = await allocator.read.signedPayloads([
          payloadId,
          hash as `0x${string}`,
        ])
        signedPayloads[hash] = extractNearSignature(signature)
      }

      if (payloadBuilderType === 'EVMPayloadBuilder') {
        // On EVM, we have a single hash and a single signature
        const { r, s, v } = signedPayloads[payloadHashes[0]]
        const signature =
          `0x${r}${s}${v.toString(16).padStart(2, '0')}` as `0x${string}`

        // EIP-712 verification
        const request = decodeCallRequest(rawPayload)

        const recoveredFromTypedData = await recoverTypedDataAddress({
          domain: {
            chainId: Number(withdrawParams.chainId),
            name: (await payloadBuilder.read.SIGNING_DOMAIN()) as string,
            verifyingContract: withdrawParams.depository as `0x${string}`,
            version: (await payloadBuilder.read.SIGNATURE_VERSION()) as string,
          },
          message: request,
          primaryType: 'CallRequest',
          signature: signature,
          types: {
            Call: [
              { name: 'to', type: 'address' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
              { name: 'allowFailure', type: 'bool' },
            ],
            CallRequest: [
              { name: 'calls', type: 'Call[]' },
              { name: 'nonce', type: 'uint256' },
              { name: 'expiration', type: 'uint256' },
            ],
          },
        })

        // send withdraw request to the depository
        const depositoryChain = extractChain({
          chains: Object.values(chains),
          id: Number(withdrawParams.chainId) as any,
        })

        const account = privateKeyToAccount(
          `0x${process.env.DEPLOYER_PRIVATE_KEY}` as `0x${string}`
        )

        const client = createWalletClient({
          account,
          chain: depositoryChain,
          transport: http(),
        })

        const publicClient = createPublicClient({
          chain: depositoryChain,
          transport: http(),
        })

        const depositoryContract = getContract({
          abi: IRelayDespository,
          address: withdrawParams.depository as `0x${string}`,
          client,
        })

        // check if allocator is set correctly on dest chain depository
        if (
          (await depositoryContract.read.allocator()) !== recoveredFromTypedData
        ) {
          throw new Error(
            'Allocator address in depository contract does not match the recovered allocator address'
          )
        }

        // check if allocator balance is enough
        let balanceIsEnough = false
        if (withdrawParams.currency === zeroAddress) {
          const balance = await publicClient.getBalance({
            address: withdrawParams.depository as `0x${string}`,
          })
          balanceIsEnough = balance >= withdrawParams.amount
        } else {
          // Get ERC20 token contract instance
          const erc20Contract = getContract({
            abi: [
              {
                constant: true,
                inputs: [{ name: 'account', type: 'address' }],
                name: 'balanceOf',
                outputs: [{ name: '', type: 'uint256' }],
                type: 'function',
              },
            ],
            address: withdrawParams.currency as `0x${string}`,
            client: publicClient,
          })
          const balance = (await erc20Contract.read.balanceOf([
            withdrawParams.depository as `0x${string}`,
          ])) as bigint
          balanceIsEnough = balance >= withdrawParams.amount
        }

        if (!balanceIsEnough) {
          throw new Error('Insufficient balance in depository')
        }

        // Check that the allocator is correct!
        if (
          (await depositoryContract.read.allocator()) !== recoveredFromTypedData
        ) {
          throw new Error(
            'Allocator address in depository contract does not match the recovered allocator address'
          )
        }

        // send withdraw request to the depository
        const tx = await depositoryContract.write.execute([request, signature])
        console.log('Withdrawal tx hash:', tx)
      } else {
        console.log(`Withdrawal not supported for ${payloadBuilderType} yet!`)
        console.log({ rawPayload, signedPayloads })
      }
    }
  )
