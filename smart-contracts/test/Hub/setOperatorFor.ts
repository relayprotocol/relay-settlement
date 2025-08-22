import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { Address, keccak256 } from 'viem'

describe('setOperatorFor', function () {
  async function deployHub() {
    const [admin, oracleUser, regularUser, operator] =
      await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    return {
      admin,
      hub,
      operator,
      oracleUser,
      publicClient,
      regularUser,
    }
  }

  let admin: any
  let hub: any
  let operator: any
  let oracleUser: any
  let publicClient: any
  let regularUser: any

  beforeEach(async function () {
    ;({ admin, hub, operator, oracleUser, publicClient, regularUser } =
      await loadFixture(deployHub))

    // Add oracle role to oracleUser
    const addOracleHash = await hub.write.grantRole(
      [keccak256('ORACLE_ROLE'), oracleUser.account.address as Address],
      {
        account: admin.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOracleHash })
  })

  it('allows oracle to set operator for any address', async function () {
    // Set operator from oracle user's perspective
    const setOperatorForHash = await hub.write.setOperatorFor(
      [
        regularUser.account.address as Address,
        operator.account.address as Address,
        Boolean(true),
      ],
      {
        account: oracleUser.account,
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

  it('reverts when non-oracle tries to set operator', async function () {
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
    ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
  })

  it('allows oracle to unset operator by passing false flag', async function () {
    // First set the operator
    const setOperatorForHash = await hub.write.setOperatorFor(
      [
        regularUser.account.address as Address,
        operator.account.address as Address,
        Boolean(true),
      ],
      {
        account: oracleUser.account,
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
        account: oracleUser.account,
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
