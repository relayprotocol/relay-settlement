import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import { DEFAULT_DELAY, deployAllocator } from '../helpers/deployAllocator'

describe('Allocator setDelay', function () {
  describe('setDelay()', function () {
    it('should revert when an attacker tries to set the delay', async function () {
      const { allocator, otherAccounts } = await loadFixture(deployAllocator)
      const attacker = otherAccounts[0]

      await expect(
        allocator.write.setDelay([1000n], {
          account: attacker.account,
        })
      ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
    })
    it('should let the owner set the delay', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      expect(await allocator.read.delay()).to.equal(DEFAULT_DELAY)

      const setDelayHash = await allocator.write.setDelay([1000n], {
        account: owner.account,
      })
      await publicClient.waitForTransactionReceipt({ hash: setDelayHash })

      expect(await allocator.read.delay()).to.equal(1000n)
    })
  })
})
