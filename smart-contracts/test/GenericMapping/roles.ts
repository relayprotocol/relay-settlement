import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { deployGenericMapping } from "../helpers/deployGenericMapping"

describe("GenericMapping roles", function () {
  it("should have ADMIN_ROLE granted to admin", async function () {
    const { store, owner } = await loadFixture(deployGenericMapping)
    const ADMIN_ROLE = await store.read.ADMIN_ROLE()
    expect(
      await store.read.hasRole([ADMIN_ROLE, owner.account.address])
    ).to.equal(true)
  })

  it("should allow admin to grant ORACLE_ROLE", async function () {
    const { store, owner, remainingAccounts } =
      await loadFixture(deployGenericMapping)
    const ORACLE_ROLE = await store.read.ORACLE_ROLE()
    const newOracle = remainingAccounts[0].account.address

    await store.write.grantRole([ORACLE_ROLE, newOracle], {
      account: owner.account,
    })

    expect(await store.read.hasRole([ORACLE_ROLE, newOracle])).to.equal(true)
  })

  it("should allow admin to revoke ORACLE_ROLE", async function () {
    const { store, owner, oracleWallet } =
      await loadFixture(deployGenericMapping)
    const ORACLE_ROLE = await store.read.ORACLE_ROLE()

    await store.write.revokeRole([ORACLE_ROLE, oracleWallet.account.address], {
      account: owner.account,
    })

    expect(
      await store.read.hasRole([ORACLE_ROLE, oracleWallet.account.address])
    ).to.equal(false)
  })

  it("should revert when non-admin tries to grant ORACLE_ROLE", async function () {
    const { store, caller, remainingAccounts } =
      await loadFixture(deployGenericMapping)
    const ORACLE_ROLE = await store.read.ORACLE_ROLE()

    await expect(
      store.write.grantRole(
        [ORACLE_ROLE, remainingAccounts[0].account.address],
        { account: caller.account }
      )
    ).to.be.rejectedWith("AccessControlUnauthorizedAccount")
  })
})
