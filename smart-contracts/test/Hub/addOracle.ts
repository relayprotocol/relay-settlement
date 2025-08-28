import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { keccak256 } from 'viem'

const ADMIN_ROLE = keccak256('ADMIN_ROLE')
const OPERATOR_ROLE = keccak256('OPERATOR_ROLE')

describe('roles / addOracle', function () {
  async function deployHub() {
    const [admin, operatorUser, attacker] = await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    return {
      admin,
      attacker,
      hub,
      operatorUser,
      publicClient,
    }
  }

  describe('constructor', function () {
    it('Should set the operator admin correctly', async function () {
      const { admin, hub } = await loadFixture(deployHub)

      expect(
        await hub.read.hasRole([ADMIN_ROLE, admin.account.address])
      ).to.equal(true)
    })
  })

  describe('Adding/removing oracles', function () {
    it('can be done by admin', async () => {
      const { admin, publicClient, operatorUser, hub } =
        await loadFixture(deployHub)
      // no role to start with
      expect(
        await hub.read.hasRole([OPERATOR_ROLE, operatorUser.account.address])
      ).to.equal(false)

      // add an operator
      const addOperatorHash = await hub.write.grantRole(
        [OPERATOR_ROLE, operatorUser.account.address],
        {
          account: admin.account,
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash: addOperatorHash,
      })
      expect(
        await hub.read.hasRole([OPERATOR_ROLE, operatorUser.account.address])
      ).to.equal(true)

      // remove operator
      const removeOperatorHash = await hub.write.revokeRole([
        OPERATOR_ROLE,
        operatorUser.account.address,
      ])
      await publicClient.waitForTransactionReceipt({ hash: removeOperatorHash })

      expect(
        await hub.read.hasRole([OPERATOR_ROLE, operatorUser.account.address])
      ).to.equal(false)
    })

    it('reverts if call by an account that is not operator admin', async () => {
      const { attacker, hub } = await loadFixture(deployHub)
      await expect(
        hub.write.grantRole([OPERATOR_ROLE, attacker.account.address], {
          account: attacker.account,
        })
      ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
    })
  })
})
