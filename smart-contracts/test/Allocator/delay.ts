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
      ).to.be.rejectedWith('OwnableUnauthorizedAccount')
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

  describe('setDepositoryDelay()', function () {
    it('should let the admin set the depository delay', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      const chainId = 1n
      const depository = 'depository1'
      const newDelay = 1000n

      // Initially, the depository delay should not be set
      const [initialDelay, initialIsSet] =
        await allocator.read.depositoryDelays([chainId, depository])
      expect(initialDelay).to.equal(0n)
      expect(initialIsSet).to.equal(false)

      // Direct call from owner (who has ADMIN_ROLE)
      const setDepositoryDelayHash = await allocator.write.setDepositoryDelay(
        [chainId, depository, newDelay],
        {
          account: owner.account,
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash: setDepositoryDelayHash,
      })

      // Verify that the depository delay has been set
      const [updatedDelay, isSet] = await allocator.read.depositoryDelays([
        chainId,
        depository,
      ])
      expect(updatedDelay).to.equal(newDelay)
      expect(isSet).to.equal(true)
    })

    it('should emit DepositoryDelayChanged event when setting depository delay', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      const chainId = 1n
      const depository = 'depository1'
      const newDelay = 1000n

      // Direct call from owner (who has ADMIN_ROLE)
      const setDepositoryDelayHash = await allocator.write.setDepositoryDelay(
        [chainId, depository, newDelay],
        {
          account: owner.account,
        }
      )
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: setDepositoryDelayHash,
      })

      // Verify that the event was emitted correctly
      const events = await allocator.getEvents.DepositoryDelayChanged({
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      })

      expect(events.length).to.equal(1)
      expect(events[0].args.chainId).to.equal(chainId)
      expect(events[0].args.depository).to.equal(depository)
      expect(events[0].args.delay).to.equal(newDelay)
    })

    it('should allow updating an existing depository delay', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      const chainId = 1n
      const depository = 'depository1'
      const initialDelay = 1000n
      const updatedDelay = 2000n

      // First set the initial delay
      let setDepositoryDelayHash = await allocator.write.setDepositoryDelay(
        [chainId, depository, initialDelay],
        {
          account: owner.account,
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash: setDepositoryDelayHash,
      })

      // Verify that the initial delay has been set
      const [initialDepositoryDelay, initialIsSet] =
        await allocator.read.depositoryDelays([chainId, depository])
      expect(initialDepositoryDelay).to.equal(initialDelay)
      expect(initialIsSet).to.equal(true)

      // Update the delay
      setDepositoryDelayHash = await allocator.write.setDepositoryDelay(
        [chainId, depository, updatedDelay],
        {
          account: owner.account,
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash: setDepositoryDelayHash,
      })

      // Verify that the delay has been updated
      const [updatedDepositoryDelay, updatedIsSet] =
        await allocator.read.depositoryDelays([chainId, depository])
      expect(updatedDepositoryDelay).to.equal(updatedDelay)
      expect(updatedIsSet).to.equal(true)
    })

    it('should allow setting depository delay to 0', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      const chainId = 1n
      const depository = 'depository1'
      const zeroDelay = 0n

      // Set delay to 0
      const setDepositoryDelayHash = await allocator.write.setDepositoryDelay(
        [chainId, depository, zeroDelay],
        {
          account: owner.account,
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash: setDepositoryDelayHash,
      })

      // Verify that the depository delay has been set to 0
      const [depositoryDelay, isSet] = await allocator.read.depositoryDelays([
        chainId,
        depository,
      ])
      expect(depositoryDelay).to.equal(zeroDelay)
      expect(isSet).to.equal(true)
    })

    it('should revert when an attacker tries to set the delay', async function () {
      const { allocator, otherAccounts } = await loadFixture(deployAllocator)
      const attacker = otherAccounts[0]
      const chainId = 1n
      const depository = 'depository1'
      const zeroDelay = 0n

      await expect(
        allocator.write.setDepositoryDelay([chainId, depository, zeroDelay], {
          account: attacker.account,
        })
      ).to.be.rejectedWith('OwnableUnauthorizedAccount')
    })
  })
})
