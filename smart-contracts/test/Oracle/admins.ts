import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"

import { deployOracle } from "../helpers/deployOracle"

describe("Admin role", function () {
  it("admin should have the rights to add and remove admins", async () => {
    const { oracle } = await loadFixture(deployOracle)

    const [admin, nonAdmin, anotherAdmin] = await hre.viem.getWalletClients()

    const ADMIN_ROLE = await oracle.read.ADMIN_ROLE()

    // Deployer has admin role by default
    expect(
      await oracle.read.hasRole([ADMIN_ROLE, admin.account.address])
    ).to.equal(true)

    // Non-admin cannot grant role
    await expect(
      oracle.write.grantRole([ADMIN_ROLE, anotherAdmin.account.address], {
        account: nonAdmin.account,
      })
    ).to.be.rejectedWith("AccessControlUnauthorizedAccount")

    // Grant role
    await oracle.write.grantRole([ADMIN_ROLE, anotherAdmin.account.address])

    // Check the role
    expect(
      await oracle.read.hasRole([ADMIN_ROLE, anotherAdmin.account.address])
    ).to.equal(true)

    // non-admin can revoke role
    await expect(
      oracle.write.revokeRole([ADMIN_ROLE, anotherAdmin.account.address], {
        account: nonAdmin.account,
      })
    ).to.be.rejectedWith("AccessControlUnauthorizedAccount")

    // Revoke role
    await oracle.write.revokeRole([ADMIN_ROLE, anotherAdmin.account.address])

    // Check the role
    expect(
      await oracle.read.hasRole([ADMIN_ROLE, anotherAdmin.account.address])
    ).to.equal(false)
  })
})
