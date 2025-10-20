import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import HubModule from "../../ignition/modules/RelayHub"

describe("Hub Deployment", function () {
  async function deployHub() {
    const [admin, anotherAdmin] = await hre.viem.getWalletClients()
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
      anotherAdmin,
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

  it("should allow admin to add/remove an admin", async function () {
    const { admin, anotherAdmin, hub } = await loadFixture(deployHub)

    const ADMIN_ROLE = await hub.read.ADMIN_ROLE()
    expect(await hub.read.getRoleAdmin([ADMIN_ROLE])).to.equal(ADMIN_ROLE)

    // check that ADMIN_ROLE is its own admin
    expect(
      await hub.read.hasRole([ADMIN_ROLE, admin.account.address])
    ).to.equal(true)

    // can add an admin
    await hub.write.grantRole([ADMIN_ROLE, anotherAdmin.account.address])
    expect(
      await hub.read.hasRole([ADMIN_ROLE, anotherAdmin.account.address])
    ).to.equal(true)
  })
})
