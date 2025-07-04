import * as bitcoin from 'bitcoinjs-lib'
import networks from '@relay-protocol/networks'
import bs58 from 'bs58'
import { task } from 'hardhat/config'
import AllocatorModule from '../../ignition/modules/Allocator'
import { bitcoinAddressfromHexPublicKey } from '../../lib/bitcoin'

const DEFAULT_DELAY = '1'

function base58ToBytes32(b58: string): string {
  const decoded = bs58.decode(b58)
  // Pad with zeros if needed to ensure 32 bytes
  const padded = Buffer.alloc(32, 0)
  // Copy the decoded bytes into the padded buffer
  padded.set(decoded, padded.length - decoded.length)
  return '0x' + padded.toString('hex')
}

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
      const [user] = await viem.getWalletClients()

      if (!owner) {
        owner = user.account.address
      }
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

task(
  'deploy:evm-payload-builder',
  'Deploys a PayloadBuilder contract'
).setAction(async (_, { viem }) => {
  const payload = await viem.deployContract('EVMPayloadBuilder')
  console.log(`PayloadBuilder deployed to: ${payload.address}`)
  return payload.address
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
