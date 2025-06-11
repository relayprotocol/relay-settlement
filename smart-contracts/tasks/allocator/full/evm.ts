import { task } from 'hardhat/config'
import * as bitcoin from 'bitcoinjs-lib'
import {
  decodeAbiParameters,
  encodeAbiParameters,
  recoverAddress,
  recoverPublicKey,
  recoverTypedDataAddress,
  zeroAddress,
} from 'viem'

import { extractNearSignature, wait } from '../../../lib/utils'

task(
  'full:evm',
  'Deploy the Allocator contract, initializes it, sets a payload builder, submits a withdraw request, triggers a signature, and verifies the payload'
)
  .addOptionalParam('owner', 'The address of the owner')
  .addParam('chainId', 'The chain ID on which we withdraw')
  .addParam('escrow', 'The address of the escrow contract')
  .addOptionalParam('signer', 'The address of the signer')
  .addOptionalParam('wnear', 'The address of the wNEAR token')
  .addOptionalParam('amount', 'The amount to withdraw from the escrow', '1')
  .addOptionalParam(
    'currency',
    'The currency to withdraw from the escrow',
    zeroAddress
  )
  .setAction(
    async (
      {
        owner,
        signer,
        wnear,
        chainId,
        escrow: escrowAddress,
        amount,
        currency,
      },
      { viem, run }
    ) => {
      // recompile contracts
      await run('compile')

      const publicClient = await viem.getPublicClient()

      const allocatorAddress = await run('deploy:allocator', {
        owner,
        signer,
        wnear,
      })

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)
      const delay = await allocator.read.delay()

      let payloadBuilderAddress = await allocator.read.payloadBuilders([
        chainId,
        escrowAddress,
      ])

      if (payloadBuilderAddress === zeroAddress) {
        console.log('PayloadBuilder not set, deploying a new one...')

        payloadBuilderAddress = await run('deploy:evm-payload-builder')

        const tx = await allocator.write.setPayloadBuilder([
          chainId,
          escrowAddress,
          payloadBuilderAddress,
        ])
        await publicClient.waitForTransactionReceipt({
          hash: tx,
        })
      }
      console.log(`Payload builder: ${payloadBuilderAddress}`)

      await run('allocator:grant-hub-role', {
        account: owner,
        allocator: allocatorAddress,
      })

      // Submit a withdraw request to the Allocator for an EVM chain!
      const payloadId = await run('allocator:submit-withdraw', {
        allocator: allocatorAddress,
        amount,
        chainId,
        currency,
        escrow: escrowAddress,
        wnear,
      })

      // Get the payload
      const payload = await allocator.read.unsignedPayloads([payloadId])
      const request = decodeCallRequest(payload)

      // Trigger a signature
      await wait(Number(delay))

      await run('allocator:sign-payload', {
        allocator: allocatorAddress,
        chainId,
        escrow: escrowAddress,
        payloadId,
        wnear,
      })

      // Verify that the signatures match
      // get the payload hashes that are to be signed
      const payloadBuilder = await viem.getContractAt(
        'EVMPayloadBuilder',
        payloadBuilderAddress
      )
      const payloadHashes = await payloadBuilder.read.hashesToSign([
        chainId,
        escrowAddress,
        payload,
      ])

      // Wait 10 seconds to "wait" for the signature to arrive
      let signedPayload = await allocator.read.signedPayloads([
        payloadId,
        payloadHashes[0],
      ])
      while (signedPayload === '0x') {
        console.log('Waiting for signed payload...')
        await wait(1)
        signedPayload = await allocator.read.signedPayloads([
          payloadId,
          payloadHashes[0],
        ])
      }

      const { r, s, v } = extractNearSignature(signedPayload)

      const signature =
        `0x${r}${s}${v.toString(16).padStart(2, '0')}` as `0x${string}`

      // Create the typed data structure
      const types = {
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
      }

      const recoveredFromHash = await recoverAddress({
        hash: payloadHashes[0],
        signature,
      })

      const publicKey = await recoverPublicKey({
        hash: payloadHashes[0],
        signature,
      })

      // EIP-712 verification
      const recoveredFromTypedData = await recoverTypedDataAddress({
        domain: {
          chainId: Number(chainId),
          name: await payloadBuilder.read.SIGNING_DOMAIN(),
          verifyingContract: escrowAddress,
          version: await payloadBuilder.read.SIGNATURE_VERSION(),
        },
        message: request,
        primaryType: 'CallRequest',
        signature,
        types,
      })

      if (recoveredFromHash !== recoveredFromTypedData) {
        throw new Error(
          `Recovered addresses do not match: ${recoveredFromHash} !== ${recoveredFromTypedData}`
        )
      }
      console.log(
        '🔍 Recovered address (make sure it is the allocator on the escrow contract):',
        recoveredFromHash
      )
      console.log(
        '🔍 Recovered public key which can be used to compute addresses on all chains with the same curve:',
        publicKey
      )
      console.log('📡 Transaction data to submit to the Escrow contract:')
      console.log({
        payload: safeStringify(request),
        signature,
      })
    }
  )

export function decodeCallRequest(encoded: `0x${string}`) {
  const callAbi = [
    {
      components: [
        {
          components: [
            { name: 'to', type: 'address' },
            { name: 'data', type: 'bytes' },
            { name: 'value', type: 'uint256' },
            { name: 'allowFailure', type: 'bool' },
          ],
          name: 'calls',
          type: 'tuple[]',
        },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
      ],
      name: 'callRequest',
      type: 'tuple',
    },
  ] as const

  const [request] = decodeAbiParameters(callAbi, encoded)
  return request
}

const safeStringify = (obj: any) =>
  JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
