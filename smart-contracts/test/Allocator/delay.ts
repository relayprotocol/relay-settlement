import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import AllocatorModule from '../../ignition/modules/Allocator'

const DEFAULT_DELAY = 600n

describe('Allocator setDelay', function () {
  async function deployAllocator() {
    const [owner, attacker] = await hre.viem.getWalletClients()
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
      attacker,
      owner,
      publicClient,
    }
  }

  describe('setDelay()', function () {
    it('should revert when an attacker tries to set the delay', async function () {
      const { allocator, attacker } = await loadFixture(deployAllocator)

      await expect(
        allocator.write.setDelay({
          account: attacker.account,
          args: [1000n],
        })
      ).to.be.rejectedWith('OwnableUnauthorizedAccount')
    })
    it('should let the owner set the delay', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      expect(await allocator.read.delay()).to.equal(DEFAULT_DELAY)

      const setDelayHash = await allocator.write.setDelay({
        account: owner.account,
        args: [1000n],
      })
      await publicClient.waitForTransactionReceipt({ hash: setDelayHash })

      expect(await allocator.read.delay()).to.equal(1000n)
    })
  })
})
