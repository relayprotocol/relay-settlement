import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { getAddress } from "viem"
import { DEFAULT_DELAY, deployAllocator } from "../helpers/deployAllocator"

describe("Allocator owner", function () {
  describe("Constructor", function () {
    it("should set the correct owner", async function () {
      const { owner, allocator } = await loadFixture(deployAllocator)
      expect(getAddress(owner.account.address)).to.equal(
        await allocator.read.owner()
      )
    })
    it("should allow the owner to transfer ownership", async function () {
      const { owner, otherAccounts, allocator } =
        await loadFixture(deployAllocator)
      // Transfer ownership to otherAccount
      await allocator.write.transferOwnership(
        [otherAccounts[3].account.address],
        { account: owner.account }
      )
      // Check new owner
      expect(await allocator.read.owner()).to.equal(
        getAddress(otherAccounts[3].account.address)
      )
    })

    it("should have delay set", async function () {
      const { allocator } = await loadFixture(deployAllocator)
      const delay = await allocator.read.delay()
      expect(delay).to.equal(DEFAULT_DELAY)
    })
  })

  describe("roles", function () {
    it("should allow owner to grant role", async function () {
      const { owner, otherAccounts, allocator } =
        await loadFixture(deployAllocator)
      const approvedWithdrawer = otherAccounts[1].account.address

      const APPROVED_WITHDRAWER_ROLE =
        await allocator.read.APPROVED_WITHDRAWER_ROLE()

      await allocator.write.grantRole(
        [APPROVED_WITHDRAWER_ROLE, approvedWithdrawer],
        {
          account: owner.account,
        }
      )

      expect(
        await allocator.read.hasRole([
          APPROVED_WITHDRAWER_ROLE,
          approvedWithdrawer,
        ])
      ).to.equal(true)
    })

    it("should allow owner to revoke a role", async function () {
      const { owner, otherAccounts, allocator } =
        await loadFixture(deployAllocator)
      const approvedWithdrawer = otherAccounts[1].account.address

      // First grant the role
      const APPROVED_WITHDRAWER_ROLE =
        await allocator.read.APPROVED_WITHDRAWER_ROLE()

      await allocator.write.grantRole(
        [APPROVED_WITHDRAWER_ROLE, approvedWithdrawer],
        {
          account: owner.account,
        }
      )

      expect(
        await allocator.read.hasRole([
          APPROVED_WITHDRAWER_ROLE,
          approvedWithdrawer,
        ])
      ).to.equal(true)

      // Then revoke it
      await allocator.write.revokeRole(
        [APPROVED_WITHDRAWER_ROLE, approvedWithdrawer],
        { account: owner.account }
      )

      expect(
        await allocator.read.hasRole([
          APPROVED_WITHDRAWER_ROLE,
          approvedWithdrawer,
        ])
      ).to.equal(false)
    })

    it("should revert when non-owner tries to grant role", async function () {
      const { otherAccounts, allocator } = await loadFixture(deployAllocator)
      const [approvedWithdrawer, attacker] = otherAccounts

      await expect(
        allocator.write.grantRole(
          [
            await allocator.read.APPROVED_WITHDRAWER_ROLE(),
            approvedWithdrawer.account.address,
          ],
          { account: attacker.account }
        )
      ).to.be.rejectedWith("OwnableUnauthorizedAccount")
    })

    it("should revert when non-owner tries to revoke role", async function () {
      const { otherAccounts, allocator } = await loadFixture(deployAllocator)
      const [approvedWithdrawer, attacker] = otherAccounts

      await expect(
        allocator.write.revokeRole(
          [
            await allocator.read.APPROVED_WITHDRAWER_ROLE(),
            approvedWithdrawer.account.address,
          ],
          { account: attacker.account }
        )
      ).to.be.rejectedWith("OwnableUnauthorizedAccount")
    })
  })
})
