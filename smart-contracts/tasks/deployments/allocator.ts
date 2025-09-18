import networks from '@relay-protocol/networks'
import * as bitcoin from 'bitcoinjs-lib'
import { task } from 'hardhat/config'
import AllocatorModule from '../../ignition/modules/Allocator'
import { bitcoinAddressfromHexPublicKey } from '../../lib/bitcoin'
import EVMPayloadBuilderModule from '../../ignition/modules/EVMPayloadBuilder'
import { keccak256 } from 'viem'

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

task(
  'allocator:grant-withdrawer-role',
  'Grant APPROVED_WITHDRAWER_ROLE to an address'
)
  .addParam('allocator', 'The address of the Allocator contract')
  .addOptionalParam('account', 'The address to grant the HUB_ROLE to')
  .setAction(async ({ allocator: allocatorAddress, account }, { viem }) => {
    const [admin] = await viem.getWalletClients()
    const publicClient = await viem.getPublicClient()

    const allocator = await viem.getContractAt('Allocator', allocatorAddress)
    if (!account) {
      account = admin.account.address
    }
    const APPROVED_WITHDRAWER_ROLE = keccak256(
      'APPROVED_WITHDRAWER_ROLE' as `0x${string}`
    )

    const hasRole = await allocator.read.hasRole([
      APPROVED_WITHDRAWER_ROLE,
      account,
    ])
    if (!hasRole) {
      console.log(
        `Granting APPROVED_WITHDRAWER_ROLE ${APPROVED_WITHDRAWER_ROLE} to ${account} ...`
      )
      const tx = await allocator.write.grantRole([
        APPROVED_WITHDRAWER_ROLE,
        account,
      ])
      console.log(`Transaction hash: ${tx}`)
      await publicClient.waitForTransactionReceipt({
        hash: tx,
      })
      console.log(`APPROVED_WITHDRAWER_ROLE granted to ${account}`)
    }
  })
