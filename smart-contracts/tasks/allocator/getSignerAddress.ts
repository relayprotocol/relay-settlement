import { ChainType } from '@relay-protocol/types'
import { task } from 'hardhat/config'
import { deriveAllocatorSignerAddress } from '../../lib/signer'

const SUPPORTED_FAMILIES: ChainType[] = [
  'bitcoin-vm',
  'ethereum-vm',
  'solana-vm',
  // 'sui-vm',
]

task(
  'allocator:signer-address',
  'Compute allocator signer address from NEAR MPC signer'
)
  .addParam('allocator', 'The address of the allocator contract')
  .addOptionalParam(
    'family',
    `The family address (${SUPPORTED_FAMILIES.join()})`,
    'ethereum-vm'
  )
  .setAction(async ({ allocator: allocatorAddress, family }, { viem }) => {
    if (!SUPPORTED_FAMILIES.includes(family)) {
      throw Error(`Family "${family}" not supported`)
    }

    console.log(
      `Computing MPC signer addresses for allocator: ${allocatorAddress}`
    )

    const publicClient = await viem.getPublicClient()
    const signerAddress = await deriveAllocatorSignerAddress(
      publicClient,
      allocatorAddress,
      family
    )
    console.log(`\n${family.toUpperCase()} signer: ${signerAddress}`)
    return signerAddress
  })
