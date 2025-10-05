import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { deployAllocator } from "../helpers/deployAllocator"
import { getAddress, zeroAddress } from "viem"

describe("Allocator setHub", function () {
  describe("setHub()", function () {
    it("should revert when an attacker tries to set the hub", async function () {
      const { allocator, otherAccounts } = await loadFixture(deployAllocator)
      const [attacker, hub] = otherAccounts

      await expect(
        allocator.write.setHub([hub.account.address], {
          account: attacker.account,
        })
      ).to.be.rejectedWith("OwnableUnauthorizedAccount")
    })
    it("should let the owner set the hub", async function () {
      const { allocator, owner, otherAccounts, publicClient } =
        await loadFixture(deployAllocator)
      const [hub] = otherAccounts

      expect(await allocator.read.hub()).to.equal(zeroAddress)

      const setHubHash = await allocator.write.setHub([hub.account.address], {
        account: owner.account,
      })
      await publicClient.waitForTransactionReceipt({ hash: setHubHash })

      expect(await allocator.read.hub()).to.equal(
        getAddress(hub.account.address)
      )
    })
  })
})
