import hre from 'hardhat'
import { ethers } from 'ethers'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import AllocatorModule from '../../ignition/modules/Allocator'

const DEFAULT_DELAY = 600n

describe('Allocator', function () {
  async function deployAllocator() {
    const [owner] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    const { allocator } = await hre.ignition.deploy(AllocatorModule, {
      parameters: {
        Allocator: {
          delay: DEFAULT_DELAY,
          owner: owner.account.address,
        },
      },
    })

    return {
      allocator,
      owner,
      publicClient,
    }
  }

  describe('Constructor', function () {
    it('should set the correct owner', async function () {
      const { owner, allocator } = await loadFixture(deployAllocator)
      expect(ethers.getAddress(owner.account.address)).to.equal(
        await allocator.read.owner()
      )
    })

    it('should be enabled by default', async function () {
      const { allocator } = await loadFixture(deployAllocator)
      const enabled = await allocator.read.enabled()
      expect(enabled).to.equal(true)
    })

    it('should have delay set', async function () {
      const { allocator } = await loadFixture(deployAllocator)
      const delay = await allocator.read.delay()
      expect(delay).to.equal(DEFAULT_DELAY)
    })
  })
})
