import {
  time,
  loadFixture,
} from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { keccak256 } from 'viem'

const HUB_ORACLE_ADMIN_ROLE = keccak256('HUB_ORACLE_ADMIN_ROLE')
const HUB_ORACLE_ROLE = keccak256('HUB_ORACLE_ROLE')

describe('roles / addOracle', function () {
  async function deployHub() {
    const [admin, oracleUser, attacker] = await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    return {
      admin,
      attacker,
      hub,
      oracleUser,
      publicClient,
    }
  }

  describe('constructor', function () {
    it('Should set the oracle admin correctly', async function () {
      const { admin, hub } = await loadFixture(deployHub)

      expect(
        await hub.read.hasRole([HUB_ORACLE_ADMIN_ROLE, admin.account.address])
      ).to.equal(true)
    })
  })

  describe('Adding/removing oracles', function () {
    it('can be done by admin', async () => {
      const { publicClient, oracleUser, hub } = await loadFixture(deployHub)
      // no role to start with
      expect(
        await hub.read.hasRole([HUB_ORACLE_ROLE, oracleUser.account.address])
      ).to.equal(false)

      // add an oracle
      const addOracleHash = await hub.write.addOracle([
        oracleUser.account.address,
      ])
      await publicClient.waitForTransactionReceipt({
        hash: addOracleHash,
      })
      expect(
        await hub.read.hasRole([HUB_ORACLE_ROLE, oracleUser.account.address])
      ).to.equal(true)

      // remove oracle
      const removeOracleHash = await hub.write.removeOracle([
        oracleUser.account.address,
      ])
      await publicClient.waitForTransactionReceipt({ hash: removeOracleHash })

      expect(
        await hub.read.hasRole([HUB_ORACLE_ROLE, oracleUser.account.address])
      ).to.equal(false)
    })

    it('reverts if call by an account that is not oracle admin', async () => {
      const { attacker, hub } = await loadFixture(deployHub)
      await expect(
        hub.write.addOracle([attacker.account.address], {
          account: attacker.account,
        })
      ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
    })
  })
})
