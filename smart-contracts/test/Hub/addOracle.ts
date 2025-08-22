import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { keccak256 } from 'viem'

const ADMIN_ROLE = keccak256('ADMIN_ROLE')
const ORACLE_ROLE = keccak256('ORACLE_ROLE')

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
        await hub.read.hasRole([ADMIN_ROLE, admin.account.address])
      ).to.equal(true)
    })
  })

  describe('Adding/removing oracles', function () {
    it('can be done by admin', async () => {
      const { publicClient, oracleUser, hub } = await loadFixture(deployHub)
      // no role to start with
      expect(
        await hub.read.hasRole([ORACLE_ROLE, oracleUser.account.address])
      ).to.equal(false)

      // add an oracle
      const addOracleHash = await hub.write.grantRole([
        keccak256('ORACLE_ROLE'),
        oracleUser.account.address,
      ])
      await publicClient.waitForTransactionReceipt({
        hash: addOracleHash,
      })
      expect(
        await hub.read.hasRole([ORACLE_ROLE, oracleUser.account.address])
      ).to.equal(true)

      // remove oracle
      const removeOracleHash = await hub.write.revokeRole([
        keccak256('ORACLE_ROLE'),
        oracleUser.account.address,
      ])
      await publicClient.waitForTransactionReceipt({ hash: removeOracleHash })

      expect(
        await hub.read.hasRole([ORACLE_ROLE, oracleUser.account.address])
      ).to.equal(false)
    })

    it('reverts if call by an account that is not oracle admin', async () => {
      const { attacker, hub } = await loadFixture(deployHub)
      await expect(
        hub.write.grantRole(
          [keccak256('ORACLE_ROLE'), attacker.account.address],
          {
            account: attacker.account,
          }
        )
      ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
    })
  })
})
