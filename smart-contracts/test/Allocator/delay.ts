import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import { DEFAULT_DELAY, deployAllocator } from '../helpers/deployAllocator'
import hre from 'hardhat'
import { encodeFunctionData } from 'viem'

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

  describe('setEscrowDelay()', function () {
    it('should let the admin set the escrow delay', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      const chainId = 1n
      const escrow = 'escrow1'
      const newDelay = 1000n

      // Initially, the escrow delay should not be set
      const [initialDelay, initialIsSet] = await allocator.read.escrowDelays([
        chainId,
        escrow,
      ])
      expect(initialDelay).to.equal(0n)
      expect(initialIsSet).to.equal(false)

      // Direct call from owner (who has ADMIN_ROLE)
      const setEscrowDelayHash = await allocator.write.setEscrowDelay(
        [chainId, escrow, newDelay],
        {
          account: owner.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: setEscrowDelayHash })

      // Verify that the escrow delay has been set
      const [updatedDelay, isSet] = await allocator.read.escrowDelays([
        chainId,
        escrow,
      ])
      expect(updatedDelay).to.equal(newDelay)
      expect(isSet).to.equal(true)
    })

    it('should emit EscrowDelayChanged event when setting escrow delay', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      const chainId = 1n
      const escrow = 'escrow1'
      const newDelay = 1000n

      // Direct call from owner (who has ADMIN_ROLE)
      const setEscrowDelayHash = await allocator.write.setEscrowDelay(
        [chainId, escrow, newDelay],
        {
          account: owner.account,
        }
      )
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: setEscrowDelayHash,
      })

      // Verify that the event was emitted correctly
      const events = await allocator.getEvents.EscrowDelayChanged({
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      })

      expect(events.length).to.equal(1)
      expect(events[0].args.chainId).to.equal(chainId)
      expect(events[0].args.escrow).to.equal(escrow)
      expect(events[0].args.delay).to.equal(newDelay)
    })

    it('should allow updating an existing escrow delay', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      const chainId = 1n
      const escrow = 'escrow1'
      const initialDelay = 1000n
      const updatedDelay = 2000n

      // First set the initial delay
      let setEscrowDelayHash = await allocator.write.setEscrowDelay(
        [chainId, escrow, initialDelay],
        {
          account: owner.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: setEscrowDelayHash })

      // Verify that the initial delay has been set
      const [initialEscrowDelay, initialIsSet] =
        await allocator.read.escrowDelays([chainId, escrow])
      expect(initialEscrowDelay).to.equal(initialDelay)
      expect(initialIsSet).to.equal(true)

      // Update the delay
      setEscrowDelayHash = await allocator.write.setEscrowDelay(
        [chainId, escrow, updatedDelay],
        {
          account: owner.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: setEscrowDelayHash })

      // Verify that the delay has been updated
      const [updatedEscrowDelay, updatedIsSet] =
        await allocator.read.escrowDelays([chainId, escrow])
      expect(updatedEscrowDelay).to.equal(updatedDelay)
      expect(updatedIsSet).to.equal(true)
    })

    it('should allow setting escrow delay to 0', async function () {
      const { allocator, owner, publicClient } =
        await loadFixture(deployAllocator)

      const chainId = 1n
      const escrow = 'escrow1'
      const zeroDelay = 0n

      // Set delay to 0
      const setEscrowDelayHash = await allocator.write.setEscrowDelay(
        [chainId, escrow, zeroDelay],
        {
          account: owner.account,
        }
      )
      await publicClient.waitForTransactionReceipt({ hash: setEscrowDelayHash })

      // Verify that the escrow delay has been set to 0
      const [escrowDelay, isSet] = await allocator.read.escrowDelays([
        chainId,
        escrow,
      ])
      expect(escrowDelay).to.equal(zeroDelay)
      expect(isSet).to.equal(true)
    })
  })
})
