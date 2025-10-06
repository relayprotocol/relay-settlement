import { expect } from "chai"
import hre from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import HubModule from "../../ignition/modules/RelayHub"

describe("Hub Deployment", function () {
  async function deployHub() {
    const [admin] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    const { hub } = await hre.ignition.deploy(HubModule, {
      parameters: {
        RelayHub: {
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

  it("should deploy Hub contract with correct operator admin", async function () {
    const { admin, hub } = await loadFixture(deployHub)

    // Get the ADMIN_ROLE
    const ADMIN_ROLE = await hub.read.ADMIN_ROLE()

    // Check if admin has the ADMIN_ROLE
    const hasRole = await hub.read.hasRole([ADMIN_ROLE, admin.account.address])
    expect(hasRole).to.equal(true)
  })
})
