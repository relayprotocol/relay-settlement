import networks from '@relay-protocol/networks'
import { task } from 'hardhat/config'
import {
  decodeAbiParameters,
  fromHex,
  recoverAddress,
  recoverTypedDataAddress,
  zeroAddress,
} from 'viem'
import AllocatorModule from '../../ignition/modules/Allocator'

const DEFAULT_DELAY = '1'

const wait = (time: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, time * 1000)
  })
}

task('deploy:allocator', 'Deploy the Allocator contract')
  .addParam('owner', 'The address of the owner')
  .addOptionalParam('signer', 'The address of the signer')
  .addOptionalParam('wnear', 'The address of the wNEAR token')
  .addOptionalParam('delay', 'The delay in seconds', DEFAULT_DELAY)
  .setAction(
    async (
      { owner, signer, wnear: wNEAR, delay },
      { ignition, run, network }
    ) => {
      const { chainId } = network.config as { chainId: number }
      const networkConfig = networks[chainId]
      if (networkConfig && networkConfig.assets) {
        if (!wNEAR) {
          wNEAR = networkConfig.assets.wNEAR
        }
        if (!wNEAR) {
          throw new Error(`No wNEAR address configured for chain ID ${chainId}`)
        }
      }
      if (!signer) {
        signer = networkConfig.isTestnet
          ? 'v1.signer-prod.testnet'
          : 'v1.signer'
      }
      const params = {
        delay: delay || DEFAULT_DELAY,
        owner,
        signer,
        wNEAR,
      }
      const { allocator } = await ignition.deploy(AllocatorModule, {
        parameters: {
          Allocator: params,
        },
      })

      console.log(`Allocator deployed to: ${allocator.address}`)

      // initialize allocator
      await run('allocator:init', {
        allocator: allocator.address,
        wNEAR,
      })

      return allocator.address
    }
  )

task('deploy:payload-builder', 'Deploys a PayloadBuilder contract')
  .addParam('payloadBuilder', 'The name of the PayloadBuilder contract')
  .setAction(async ({ payloadBuilder }, { viem }) => {
    const payload = await viem.deployContract(payloadBuilder)
    console.log(`PayloadBuilder deployed to: ${payload.address}`)
    return payload.address
  })

task(
  'deploy:full',
  'Deploy the Allocator contract, initializes it, sets a payload builder, submits a withdraw request, triggers a signature, and verifies the payload'
)
  .addParam('owner', 'The address of the owner')
  .addOptionalParam('chainId', 'The chain ID on which we withdraw')
  .addOptionalParam('escrow', 'The address of the escrow contract')
  .addOptionalParam('signer', 'The address of the signer')
  .addOptionalParam('wnear', 'The address of the wNEAR token')
  .addOptionalParam('amount', 'The amount to withdraw from the escrow', '1')
  .addOptionalParam(
    'currency',
    'The currency to withdraw from the escrow',
    zeroAddress
  )
  .addOptionalParam('delay', 'The delay in seconds', DEFAULT_DELAY)
  .setAction(
    async (
      {
        owner,
        signer,
        wnear,
        delay,
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
        delay,
        owner,
        signer,
        wnear,
      })

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)

      let payloadBuilderAddress = await allocator.read.payloadBuilders([
        chainId,
        escrowAddress,
      ])
      if (payloadBuilderAddress === zeroAddress) {
        console.log('PayloadBuilder not set, deploying a new one...')

        payloadBuilderAddress = await run('deploy:payload-builder', {
          payloadBuilder: 'EVMPayloadBuilder',
        })

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
      await wait(delay)

      await run('allocator:sign-payload', {
        allocator: allocatorAddress,
        chainId,
        escrow: escrowAddress,
        payloadId,
        wnear,
      })

      // Verify that the signatures match

      const payloadBuilder = await viem.getContractAt(
        'EVMPayloadBuilder',
        payloadBuilderAddress
      )
      const payloadHash = await payloadBuilder.read.hashPayload([
        chainId,
        escrowAddress,
        payload,
      ])

      // Wait 10 seconds to "wait" for the signature to arrive
      let signedPayload = await allocator.read.signedPayloads([payloadId])
      while (signedPayload === '0x') {
        console.log('Waiting for signed payload...')
        await wait(1)
        signedPayload = await allocator.read.signedPayloads([payloadId])
      }
      const jsonSignature = JSON.parse(fromHex(signedPayload, 'string'))

      const {
        big_r: { affine_point },
        s: { scalar },
        recovery_id,
      } = jsonSignature

      const r = affine_point.substring(2)
      const s = scalar
      const v = recovery_id + 27 // Convert to 0 or 1 for EIP-1559 compatibility

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
        hash: payloadHash,
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
        'Recovered address (make sure it is the allocator on the escrow contract):',
        recoveredFromHash
      )

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
