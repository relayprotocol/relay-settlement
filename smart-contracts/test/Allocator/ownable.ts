import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import { ethers } from 'ethers'
import { DEFAULT_DELAY, deployAllocator } from '../helpers/deployAllocator'

describe('Allocator', function () {
  describe('Constructor', function () {
    it('should set the correct owner', async function () {
      const { owner, allocator } = await loadFixture(deployAllocator)
      expect(ethers.getAddress(owner.account.address)).to.equal(
        await allocator.read.owner()
      )
    })

    it('should be disabled by default', async function () {
      const { allocator } = await loadFixture(deployAllocator)
      const enabled = await allocator.read.enabled()
      expect(enabled).to.equal(false)
    })

    it('should have delay set', async function () {
      const { allocator } = await loadFixture(deployAllocator)
      const delay = await allocator.read.delay()
      expect(delay).to.equal(DEFAULT_DELAY)
    })
  })
})
