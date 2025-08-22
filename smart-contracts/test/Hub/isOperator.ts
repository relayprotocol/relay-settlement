import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { keccak256 } from 'viem'

describe('isOperator', function () {
  async function deployHub() {
    const [admin, oracleUser, regularUser, operatorUser] =
      await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    // Add oracle role to oracleUser
    const addOracleHash = await hub.write.grantRole([
      keccak256('ORACLE_ROLE'),
      oracleUser.account.address,
    ])
    await publicClient.waitForTransactionReceipt({ hash: addOracleHash })

    return {
      admin,
      hub,
      operatorUser,
      oracleUser,
      publicClient,
      regularUser,
    }
  }
  describe('returns true', () => {
    it('when operator has oracle role', async function () {
      const { oracleUser, regularUser, hub } = await loadFixture(deployHub)

      // Check isOperator from oracle user's perspective
      const isOperator = await hub.read.isOperator([
        oracleUser.account.address,
        regularUser.account.address,
      ])

      expect(isOperator).to.equal(true)
    })

    it('when operator is set', async function () {
      const { regularUser, oracleUser, operatorUser, hub, publicClient } =
        await loadFixture(deployHub)

      // set operator
      const setOperatorForHash = await hub.write.setOperatorFor(
        [regularUser.account.address, operatorUser.account.address, true],
        {
          account: oracleUser.account,
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash: setOperatorForHash,
      })

      // Check isOperator from regular user's perspective
      const isOperator = await hub.read.isOperator([
        regularUser.account.address,
        operatorUser.account.address,
      ])

      expect(isOperator).to.equal(true)
    })

    // by default, an account is NOT operator of its own address
    it('when operator is self', async function () {
      const { regularUser, hub } = await loadFixture(deployHub)
      const isOperator = await hub.read.isOperator([
        regularUser.account.address,
        regularUser.account.address,
      ])
      expect(isOperator).to.equal(false)
    })
  })
  describe('returns false', () => {
    it('when operator is not set', async function () {
      const { regularUser, operatorUser, hub } = await loadFixture(deployHub)
      const isOperator = await hub.read.isOperator([
        regularUser.account.address,
        operatorUser.account.address,
      ])

      expect(isOperator).to.equal(false)
    })
    it('when operator is unset', async function () {
      const { regularUser, oracleUser, operatorUser, hub, publicClient } =
        await loadFixture(deployHub)

      // unset operator
      const setOperatorForHash = await hub.write.setOperatorFor(
        [regularUser.account.address, operatorUser.account.address, false],
        {
          account: oracleUser.account,
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash: setOperatorForHash,
      })

      // Check isOperator from regular user's perspective
      const isOperator = await hub.read.isOperator([
        regularUser.account.address,
        operatorUser.account.address,
      ])

      expect(isOperator).to.equal(false)
    })
  })
})
