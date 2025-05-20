import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { encodeFunctionData } from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import AllocatorModule from '../../ignition/modules/Allocator'

const DEFAULT_DELAY = 600n

describe('Allocator disable/enable', function () {
  async function deployAllocator() {
    const [owner, admin, attacker] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    const mockSafe = await hre.viem.deployContract('MockSafe', [])

    await mockSafe.write.addOwner([owner.account.address])
    await mockSafe.write.addOwner([admin.account.address])

    const { allocator } = await hre.ignition.deploy(AllocatorModule, {
      parameters: {
        Allocator: {
          delay: DEFAULT_DELAY,
          owner: mockSafe.address,
        },
      },
    })

    return {
      admin,
      allocator,
      attacker,
      mockSafe,
      owner,
      publicClient,
    }
  }

  describe('disable()', function () {
    it('should allow any multisig owner to disable the contract', async function () {
      const { allocator, admin, publicClient } =
        await loadFixture(deployAllocator)

      expect(await allocator.read.enabled()).to.equal(true)

      const disableHash = await allocator.write.disable({
        account: admin.account,
      })
      await publicClient.waitForTransactionReceipt({ hash: disableHash })

      expect(await allocator.read.enabled()).to.equal(false)
    })

    it('should revert when non-admin tries to disable the contract', async function () {
      const { allocator, attacker } = await loadFixture(deployAllocator)

      await expect(
        allocator.write.disable({
          account: attacker.account,
        })
      ).to.be.rejectedWith('NotMultisigOwner')
    })
  })

  describe('enable()', function () {
    it('should require multisig signature to enable the contract', async function () {
      const { allocator, owner, admin, publicClient, mockSafe } =
        await loadFixture(deployAllocator)

      const disableHash = await allocator.write.disable({
        account: admin.account,
      })
      await publicClient.waitForTransactionReceipt({ hash: disableHash })
      expect(await allocator.read.enabled()).to.equal(false)

      // simulate multisig execution
      const data = encodeFunctionData({
        abi: allocator.abi,
        args: [],
        functionName: 'enable',
      })

      const enableHash = await mockSafe.write.execute(
        [allocator.address, 0n, data],
        {
          account: owner.account,
        }
      )

      await publicClient.waitForTransactionReceipt({ hash: enableHash })
      expect(await allocator.read.enabled()).to.equal(true)
    })

    it('should revert when non-owner tries to enable the contract', async function () {
      const { allocator, admin, attacker, publicClient } =
        await loadFixture(deployAllocator)

      const disableHash = await allocator.write.disable({
        account: admin.account,
      })
      await publicClient.waitForTransactionReceipt({ hash: disableHash })
      expect(await allocator.read.enabled()).to.equal(false)

      await expect(
        allocator.write.enable({
          account: attacker.account,
        })
      ).to.be.rejectedWith('OwnableUnauthorizedAccount')
    })
  })
})
