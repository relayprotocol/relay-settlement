import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { keccak256 } from 'viem'

describe('isOperator', function () {
  async function deployHub() {
    const [admin, regularUser, operatorUser, anotherUserToBeOperator] =
      await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    // Add operator role to operatorUser
    const addOperatorHash = await hub.write.grantRole(
      [keccak256('OPERATOR_ROLE'), operatorUser.account.address],
      {
        account: admin.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOperatorHash })

    return {
      admin,
      anotherUserToBeOperator,
      hub,
      operatorUser,
      publicClient,
      regularUser,
    }
  }
  describe('returns true', () => {
    it('when operator has operator role', async function () {
      const { operatorUser, regularUser, hub } = await loadFixture(deployHub)

      // Check isOperator from operator user's perspective
      const isOperator = await hub.read.isOperator([
        regularUser.account.address,
        operatorUser.account.address,
      ])

      expect(isOperator).to.equal(true)
    })

    it('when operator is set', async function () {
      const { regularUser, operatorUser, hub, publicClient } =
        await loadFixture(deployHub)

      // set operator
      const setOperatorForHash = await hub.write.setOperatorFor(
        [regularUser.account.address, operatorUser.account.address, true],
        {
          account: operatorUser.account,
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
      const { regularUser, anotherUserToBeOperator, hub } =
        await loadFixture(deployHub)
      const isOperator = await hub.read.isOperator([
        regularUser.account.address,
        anotherUserToBeOperator.account.address,
      ])

      expect(isOperator).to.equal(false)
    })
    it('when operator is unset', async function () {
      const {
        regularUser,
        anotherUserToBeOperator,
        hub,
        operatorUser,
        publicClient,
      } = await loadFixture(deployHub)

      // unset operator
      const setOperatorForHash = await hub.write.setOperatorFor(
        [
          regularUser.account.address,
          anotherUserToBeOperator.account.address,
          false,
        ],
        {
          account: operatorUser.account,
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash: setOperatorForHash,
      })

      // Check isOperator from regular user's perspective
      const isOperator = await hub.read.isOperator([
        regularUser.account.address,
        anotherUserToBeOperator.account.address,
      ])

      expect(isOperator).to.equal(false)
    })
  })
})
