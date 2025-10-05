import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"

import { deployOracle } from "../helpers/deployOracle"

describe("addAndRemoveOracles", function () {
  it("admin and only admin should have the rights to add and remove oracles", async () => {
    const { oracle } = await loadFixture(deployOracle)

    const [, nonAdmin, oracleWallet] = await hre.viem.getWalletClients()

    const ORACLE_ROLE = await oracle.read.ORACLE_ROLE()

    // There's no role to start with
    expect(
      await oracle.read.hasRole([ORACLE_ROLE, oracleWallet.account.address])
    ).to.equal(false)

    // Non-admin cannot grant role
    await expect(
      oracle.write.grantRole([ORACLE_ROLE, oracleWallet.account.address], {
        account: nonAdmin.account,
      })
    ).to.be.rejectedWith("AccessControlUnauthorizedAccount")

    // Grant role
    await oracle.write.grantRole([ORACLE_ROLE, oracleWallet.account.address])

    // Check the role
    expect(
      await oracle.read.hasRole([ORACLE_ROLE, oracleWallet.account.address])
    ).to.equal(true)

    // Non-admin cannot revoke role
    await expect(
      oracle.write.revokeRole([ORACLE_ROLE, oracleWallet.account.address], {
        account: nonAdmin.account,
      })
    ).to.be.rejectedWith("AccessControlUnauthorizedAccount")

    // Revoke role
    await oracle.write.revokeRole([ORACLE_ROLE, oracleWallet.account.address])

    // Check the role
    expect(
      await oracle.read.hasRole([ORACLE_ROLE, oracleWallet.account.address])
    ).to.equal(false)
  })
})
