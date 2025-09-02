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
    it('should allow the owner to transfer ownership', async function () {
      const { owner, otherAccounts, allocator } =
        await loadFixture(deployAllocator)
      // Transfer ownership to otherAccount
      await allocator.write.transferOwnership(
        [otherAccounts[3].account.address],
        { account: owner.account }
      )
      // Check new owner
      expect(await allocator.read.owner()).to.equal(
        ethers.getAddress(otherAccounts[3].account.address)
      )
    })

    it('should have delay set', async function () {
      const { allocator } = await loadFixture(deployAllocator)
      const delay = await allocator.read.delay()
      expect(delay).to.equal(DEFAULT_DELAY)
    })
  })
})
