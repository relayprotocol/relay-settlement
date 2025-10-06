import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { Address, keccak256 } from "viem"

describe("setOperatorFor", function () {
  async function deployHub() {
    const [admin, operatorUser, regularUser, operator] =
      await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract("RelayHub", [
      admin.account.address,
    ])
    const publicClient = await hre.viem.getPublicClient()

    return {
      admin,
      hub,
      operator,
      operatorUser,
      publicClient,
      regularUser,
    }
  }

  let admin: any
  let hub: any
  let operator: any
  let operatorUser: any
  let publicClient: any
  let regularUser: any

  beforeEach(async function () {
    ;({ admin, hub, operator, operatorUser, publicClient, regularUser } =
      await loadFixture(deployHub))

    // Add operator role to operatorUser
    const addOperatorHash = await hub.write.grantRole(
      [keccak256("OPERATOR_ROLE"), operatorUser.account.address as Address],
      {
        account: admin.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOperatorHash })
  })

  it("allows operator to set operator for any address", async function () {
    // Set operator from operator user's perspective
    const setOperatorForHash = await hub.write.setOperatorFor(
      [
        regularUser.account.address as Address,
        operator.account.address as Address,
        Boolean(true),
      ],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: setOperatorForHash })

    // Verify operator was set
    const isOperator = await hub.read.isOperator([
      regularUser.account.address as Address,
      operator.account.address as Address,
    ])
    expect(isOperator).to.equal(true)
  })

  it("reverts when non-oracle tries to set operator", async function () {
    // Attempt to set operator from regular user's perspective
    await expect(
      hub.write.setOperatorFor(
        [
          regularUser.account.address as Address,
          operator.account.address as Address,
          Boolean(true),
        ],
        {
          account: regularUser.account,
        }
      )
    ).to.be.rejectedWith("AccessControlUnauthorizedAccount")
  })

  it("allows oracle to unset operator by passing false flag", async function () {
    // First set the operator
    const setOperatorForHash = await hub.write.setOperatorFor(
      [
        regularUser.account.address as Address,
        operator.account.address as Address,
        Boolean(true),
      ],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: setOperatorForHash })

    // Verify operator was set
    let isOperator = await hub.read.isOperator([
      regularUser.account.address as Address,
      operator.account.address as Address,
    ])
    expect(isOperator).to.equal(true)

    // Now unset the operator
    const unsetOperatorForHash = await hub.write.setOperatorFor(
      [
        regularUser.account.address as Address,
        operator.account.address as Address,
        Boolean(false),
      ],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({
      hash: unsetOperatorForHash,
    })

    // Verify operator was unset
    isOperator = await hub.read.isOperator([
      regularUser.account.address as Address,
      operator.account.address as Address,
    ])
    expect(isOperator).to.equal(false)
  })
})
