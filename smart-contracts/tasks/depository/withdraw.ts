import { task } from 'hardhat/config'
import {
  createWalletClient,
  extractChain,
  getContract,
  http,
  recoverTypedDataAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'
import { decodeCallRequest, IRelayDespository } from '../../lib/evm'
import { extractNearSignature } from '../../lib/near'

task('depository:withdraw', 'Withdraw from depository')
  .addParam('allocator', 'The address of the allocator contract')
  .addParam('payloadId', 'The payloadId to use')
  .addParam('chainId', 'The chainId on which the withdrawal will be made')
  .addParam(
    'depository',
    'The depository contract address from which to withdraw'
  )
  .setAction(
    async (
      { allocator: allocatorAddress, payloadId, depository, chainId },
      hre
    ) => {
      const { viem } = hre

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)
      const payload = await allocator.read.payloads([payloadId])

      const payloadBuilderAddress = await allocator.read.payloadBuilders([
        chainId,
        depository,
      ])

      // get the signed payload
      const payloadBuilder = await viem.getContractAt(
        'EVMPayloadBuilder',
        payloadBuilderAddress
      )
      const payloadHashes = await payloadBuilder.read.hashesToSign([
        chainId,
        depository,
        payload[1] as `0x${string}`,
      ])

      const signedPayload = await allocator.read.signedPayloads([
        payloadId,
        payloadHashes[0],
      ])

      // get signature from signed payload
      const { r, s, v } = extractNearSignature(signedPayload)
      const signature =
        `0x${r}${s}${v.toString(16).padStart(2, '0')}` as `0x${string}`

      // EIP-712 verification
      const request = decodeCallRequest(payload[1])
      console.log('request', request)

      const recoveredFromTypedData = await recoverTypedDataAddress({
        domain: {
          chainId: Number(chainId),
          name: await payloadBuilder.read.SIGNING_DOMAIN(),
          verifyingContract: depository,
          version: await payloadBuilder.read.SIGNATURE_VERSION(),
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

      console.log('recovered address', recoveredFromTypedData)

      // send withdraw request to the depository
      const depositoryChain = extractChain({
        chains: Object.values(chains),
        id: Number(chainId) as any,
      })

      const depositoryAccount = privateKeyToAccount(
        `0x${process.env.DEPLOYER_PRIVATE_KEY}` as `0x${string}`
      )

      const client = createWalletClient({
        account: depositoryAccount,
        chain: depositoryChain,
        transport: http(),
      })

      const depositoryContract = getContract({
        abi: IRelayDespository,
        address: depository,
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

      // send withdraw request to the depository
      const tx = await depositoryContract.write.execute([request, signature])
      console.log('Depository tx hash:', tx)
    }
  )
