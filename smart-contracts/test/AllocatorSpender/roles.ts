import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { deployAllocatorSpender } from "../helpers/deployAllocatorSpender"

describe("RelayAllocatorSpender roles", function () {
  it("should have ADMIN_ROLE granted to admin", async function () {
    const { spender, owner } = await loadFixture(deployAllocatorSpender)
    const ADMIN_ROLE = await spender.read.ADMIN_ROLE()
    expect(
      await spender.read.hasRole([ADMIN_ROLE, owner.account.address])
    ).to.equal(true)
  })

  it("should allow admin to grant ORACLE_ROLE", async function () {
    const { spender, owner, remainingAccounts } = await loadFixture(
      deployAllocatorSpender
    )
    const ORACLE_ROLE = await spender.read.ORACLE_ROLE()
    const newOracle = remainingAccounts[0].account.address

    await spender.write.grantRole([ORACLE_ROLE, newOracle], {
      account: owner.account,
    })

    expect(await spender.read.hasRole([ORACLE_ROLE, newOracle])).to.equal(true)
  })

  it("should allow admin to revoke ORACLE_ROLE", async function () {
    const { spender, owner, oracleWallet } = await loadFixture(
      deployAllocatorSpender
    )
    const ORACLE_ROLE = await spender.read.ORACLE_ROLE()

    await spender.write.revokeRole(
      [ORACLE_ROLE, oracleWallet.account.address],
      { account: owner.account }
    )

    expect(
      await spender.read.hasRole([ORACLE_ROLE, oracleWallet.account.address])
    ).to.equal(false)
  })

  it("should revert when non-admin tries to grant ORACLE_ROLE", async function () {
    const { spender, caller, remainingAccounts } = await loadFixture(
      deployAllocatorSpender
    )
    const ORACLE_ROLE = await spender.read.ORACLE_ROLE()

    await expect(
      spender.write.grantRole(
        [ORACLE_ROLE, remainingAccounts[0].account.address],
        { account: caller.account }
      )
    ).to.be.rejectedWith("AccessControlUnauthorizedAccount")
  })
})
