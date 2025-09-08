import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { encodeFunctionData, keccak256 } from 'viem'
import { deployAllocator } from '../helpers/deployAllocator'

const APPROVED_WITHDRAWER_ROLE = keccak256(
  'APPROVED_WITHDRAWER_ROLE'
) as `0x${string}`

describe('Allocator suspend', function () {
  async function deployAllocatorWithSafe() {
    const [owner, admin, attacker, solver] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    const mockSafe = await hre.viem.deployContract('MockSafe', [])

    await mockSafe.write.addOwner([owner.account.address])
    await mockSafe.write.addOwner([admin.account.address])

    const { allocator } = await deployAllocator({
      owner: mockSafe.address,
    })

    // simulate multisig execution to enable the allocator
    const data = encodeFunctionData({
      abi: allocator.abi,
      args: [APPROVED_WITHDRAWER_ROLE, solver.account.address],
      functionName: 'grantRole',
    })

    const enableHash = await mockSafe.write.execute(
      [allocator.address, 0n, data],
      {
        account: owner.account,
      }
    )

    await publicClient.waitForTransactionReceipt({ hash: enableHash })

    return {
      admin,
      allocator,
      attacker,
      mockSafe,
      owner,
      publicClient,
      solver,
    }
  }

  describe('suspend()', function () {
    it('should allow any multisig owner to suspend the contract', async function () {
      const { allocator, admin, publicClient, solver } = await loadFixture(
        deployAllocatorWithSafe
      )

      expect(
        await allocator.read.hasRole([
          APPROVED_WITHDRAWER_ROLE,
          solver.account.address,
        ])
      ).to.equal(true)

      const suspendHash = await allocator.write.suspend(
        [solver.account.address],
        {
          account: admin.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: suspendHash })

      expect(
        await allocator.read.hasRole([
          APPROVED_WITHDRAWER_ROLE,
          solver.account.address,
        ])
      ).to.equal(false)
    })

    it('should revert when non-admin tries to disable the contract', async function () {
      const { allocator, attacker } = await loadFixture(deployAllocatorWithSafe)

      await expect(
        allocator.write.disable({
          account: attacker.account,
        })
      ).to.be.rejected
    })
  })

  describe('re-add role after being suspended', function () {
    it('should require multisig signature to add a new WITHDRAWER', async function () {
      const { allocator, owner, admin, publicClient, mockSafe, solver } =
        await loadFixture(deployAllocatorWithSafe)

      const disableHash = await allocator.write.suspend(
        [solver.account.address],
        {
          account: admin.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: disableHash })
      expect(
        await allocator.read.hasRole([
          APPROVED_WITHDRAWER_ROLE,
          solver.account.address,
        ])
      ).to.equal(false)

      // simulate multisig execution
      const data = encodeFunctionData({
        abi: allocator.abi,
        args: [APPROVED_WITHDRAWER_ROLE, solver.account.address],
        functionName: 'grantRole',
      })

      const enableHash = await mockSafe.write.execute(
        [allocator.address, 0n, data],
        {
          account: owner.account,
        }
      )

      await publicClient.waitForTransactionReceipt({ hash: enableHash })
      expect(
        await allocator.read.hasRole([
          APPROVED_WITHDRAWER_ROLE,
          solver.account.address,
        ])
      ).to.equal(true)
    })

    it('should revert when non-owner tries to add a new WITHDRAWER', async function () {
      const { allocator, admin, attacker, publicClient, solver } =
        await loadFixture(deployAllocatorWithSafe)

      const disableHash = await allocator.write.suspend(
        [solver.account.address],
        {
          account: admin.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: disableHash })
      expect(
        await allocator.read.hasRole([
          APPROVED_WITHDRAWER_ROLE,
          solver.account.address,
        ])
      ).to.equal(false)

      await expect(
        allocator.write.grantRole(
          [APPROVED_WITHDRAWER_ROLE, solver.account.address],
          {
            account: attacker.account,
          }
        )
      ).to.be.rejectedWith('OwnableUnauthorizedAccount')
    })
  })
})
