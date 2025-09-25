import networks from '@relay-protocol/networks'
import * as bitcoin from 'bitcoinjs-lib'
import { task } from 'hardhat/config'
import AllocatorModule from '../../ignition/modules/Allocator'
import { bitcoinAddressfromHexPublicKey } from '../../lib/bitcoin'
import EVMPayloadBuilderModule from '../../ignition/modules/EVMPayloadBuilder'

const DEFAULT_DELAY = '1'

task('deploy:allocator', 'Deploy the Allocator contract')
  .addOptionalParam('owner', 'The address of the owner')
  .addOptionalParam('signer', 'The address of the signer')
  .addOptionalParam('wnear', 'The address of the wNEAR token')
  .addOptionalParam('delay', 'The delay in seconds', DEFAULT_DELAY)
  .setAction(
    async (
      { owner, signer, wnear: wNEAR, delay },
      { ignition, run, network, viem }
    ) => {
      // recompile before deploying
      await run('compile')

      const [user] = await viem.getWalletClients()

      if (!owner) {
        owner = user.account.address
      }
      const { chainId } = network.config as { chainId: bigint }
      const networkConfig = networks[chainId.toString()]
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
  .addParam('payloadBuilder', 'The name of the payload builder contract')
  .setAction(async ({ payloadBuilder }, { viem }) => {
    // Let's now deploy the payload builder contract
    const payloadBuilderContract = await viem.deployContract(payloadBuilder)
    console.log(
      `${payloadBuilder} deployed to: ${payloadBuilderContract.address}`
    )
    return payloadBuilderContract.address
  })

task(
  'deploy:evm-payload-builder',
  'Deploys an EVM Payload Builder contract'
).setAction(async (_, { ignition }) => {
  // Let's now deploy the payload builder contract
  const { evmPayloadBuilder } = await ignition.deploy(EVMPayloadBuilderModule, {
    parameters: {},
  })

  console.log(`EvmPayloadBuilder deployed to: ${evmPayloadBuilder.address}`)
  return evmPayloadBuilder.address
})

task('deploy:bitcoin-payload-builder', 'Deploys a PayloadBuilder contract')
  .addParam('allocatorPublicKey', 'The ethereum public key of the allocator')
  .setAction(async ({ allocatorPublicKey }, { viem }) => {
    const bitcoinAddress = bitcoinAddressfromHexPublicKey(allocatorPublicKey)
    console.log('Allocator Bitcoin address:', bitcoinAddress)

    const changeScript = bitcoin.address.toOutputScript(
      bitcoinAddress,
      bitcoin.networks.testnet
    )

    // Let's now deploy the BitcoinPayloadBuilder contract
    const payloadBuilder = await viem.deployContract('BitcoinPayloadBuilder', [
      changeScript.toString('base64'),
    ])

    console.log(`PayloadBuilder deployed to: ${payloadBuilder.address}`)
    return payloadBuilder.address
  })
