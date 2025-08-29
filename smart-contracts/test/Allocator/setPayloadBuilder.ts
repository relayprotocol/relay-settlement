import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import { getAddress, zeroAddress } from 'viem'
import { deployAllocator } from '../helpers/deployAllocator'

describe('Allocator - setPayloadBuilder', function () {
  async function deployAllocatorWithSetup() {
    const { allocator, owner, otherAccounts, publicClient } =
      await deployAllocator()
    const [nonOwner, depository, payloadBuilder] = otherAccounts

    return {
      allocator,
      depository,
      nonOwner,
      owner,
      payloadBuilder,
      publicClient,
    }
  }

  it('should not have a payload builder if none is set for that depository and chainId', async function () {
    const { allocator, depository } = await loadFixture(
      deployAllocatorWithSetup
    )
    const chainId = 1n
    const builder = await allocator.read.payloadBuilders([
      chainId,
      depository.account.address,
    ])
    // Verify payload builder was set
    expect(getAddress(builder)).to.equal(zeroAddress)
  })

  it('should allow owner to set payload builder', async function () {
    const { allocator, owner, depository, payloadBuilder, publicClient } =
      await loadFixture(deployAllocatorWithSetup)
    const chainId = 1n

    const setPayloadBuilderHash = await allocator.write.setPayloadBuilder(
      [chainId, depository.account.address, payloadBuilder.account.address],
      {
        account: owner.account,
      }
    )
    await publicClient.waitForTransactionReceipt({
      hash: setPayloadBuilderHash,
    })

    // Verify payload builder was set
    const builder = await allocator.read.payloadBuilders([
      chainId,
      depository.account.address,
    ])
    expect(getAddress(builder)).to.equal(
      getAddress(payloadBuilder.account.address)
    )

    expect(
      getAddress(
        await allocator.read.payloadBuilders([
          chainId + 1n,
          depository.account.address,
        ])
      )
    ).to.equal(zeroAddress)

    expect(
      getAddress(
        await allocator.read.payloadBuilders([
          chainId,
          payloadBuilder.account.address,
        ])
      )
    ).to.equal(zeroAddress)

    // Verify event was emitted
    const [log] = await publicClient.getContractEvents({
      abi: allocator.abi,
      address: allocator.address,
      eventName: 'PayloadBuilderUpdated',
    })
    expect(log.args.chainId).to.equal(chainId)
    expect(getAddress(log.args.builder!)).to.equal(
      getAddress(payloadBuilder.account.address)
    )
  })

  it('should allow owner to update existing payload builder', async function () {
    const {
      allocator,
      owner,
      nonOwner,
      depository,
      payloadBuilder,
      publicClient,
    } = await loadFixture(deployAllocatorWithSetup)
    const chainId = 1n

    // Set initial builder
    const setPayloadBuilderHash = await allocator.write.setPayloadBuilder(
      [chainId, depository.account.address, payloadBuilder.account.address],
      {
        account: owner.account,
      }
    )
    await publicClient.waitForTransactionReceipt({
      hash: setPayloadBuilderHash,
    })

    // Update builder
    const updatePayloadBuilderHash = await allocator.write.setPayloadBuilder(
      [chainId, depository.account.address, nonOwner.account.address],
      {
        account: owner.account,
      }
    )
    await publicClient.waitForTransactionReceipt({
      hash: updatePayloadBuilderHash,
    })

    // Verify payload builder was updated
    const builder = await allocator.read.payloadBuilders([
      chainId,
      depository.account.address,
    ])
    expect(getAddress(builder)).to.equal(getAddress(nonOwner.account.address))
  })

  it('should not allow non-owner to set payload builder', async function () {
    const { allocator, nonOwner, depository, payloadBuilder } =
      await loadFixture(deployAllocatorWithSetup)
    const chainId = 1n

    await expect(
      allocator.write.setPayloadBuilder(
        [chainId, depository.account.address, payloadBuilder.account.address],
        {
          account: nonOwner.account,
        }
      )
    ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
  })
})
