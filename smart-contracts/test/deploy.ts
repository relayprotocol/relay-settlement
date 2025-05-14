import { expect } from 'chai'
import hre from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import HubModule from '../ignition/modules/Hub'

describe('Hub Deployment', function () {
  async function deployHub() {
    const [admin] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    const { hub } = await hre.ignition.deploy(HubModule, {
      parameters: {
        Hub: {
          admin: admin.account.address,
        },
      },
    })

    return {
      admin,
      hub,
      publicClient,
    }
  }

  it('should deploy Hub contract with correct oracle admin', async function () {
    const { admin, hub } = await loadFixture(deployHub)

    // Get the HUB_ORACLE_ADMIN_ROLE
    const HUB_ORACLE_ADMIN_ROLE = await hub.read.HUB_ORACLE_ADMIN_ROLE()

    // Check if admin has the HUB_ORACLE_ADMIN_ROLE
    const hasRole = await hub.read.hasRole([
      HUB_ORACLE_ADMIN_ROLE,
      admin.account.address,
    ])
    expect(hasRole).to.equal(true)
  })
})
