import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { keccak256, stringToHex, toHex } from "viem"

async function deployConfig() {
  const [owner, newOwner, ...otherAccounts] = await hre.viem.getWalletClients()
  const utils = await hre.viem.deployContract("Utils", [])
  const hub = await hre.viem.deployContract("RelayHub", [owner.account.address])
  const allocator = await hre.viem.deployContract(
    "RelayAllocator",
    [owner.account.address, hub.address],
    {
      libraries: {
        Utils: utils.address,
      },
    }
  )
  const replacementAllocator = await hre.viem.deployContract(
    "RelayAllocator",
    [newOwner.account.address, hub.address],
    {
      libraries: {
        Utils: utils.address,
      },
    }
  )
  const config = await hre.viem.deployContract("Config", [allocator.address])

  return {
    allocator,
    config,
    hub,
    newOwner,
    otherAccounts,
    owner,
    replacementAllocator,
  }
}

describe("Config", function () {
  it("sets and reads a single value", async function () {
    const { config, owner } = await loadFixture(deployConfig)
    const key = keccak256(stringToHex("ethereum-mainnet"))
    const value = toHex(1n, { size: 32 })

    await config.write.setConfigValue([key, value], { account: owner.account })

    expect(await config.read.getConfigValue([key])).to.equal(value)
  })

  it("sets multiple values", async function () {
    const { config, owner } = await loadFixture(deployConfig)
    const keys = [
      keccak256(stringToHex("ethereum-mainnet")),
      keccak256(stringToHex("base-mainnet")),
    ]
    const values = [toHex(1n, { size: 32 }), toHex(8453n, { size: 32 })]

    await config.write.setConfigValues([keys, values], {
      account: owner.account,
    })

    expect(await config.read.getConfigValue([keys[0]])).to.equal(values[0])
    expect(await config.read.getConfigValue([keys[1]])).to.equal(values[1])
  })

  it("reverts when reading an unset key", async function () {
    const { config } = await loadFixture(deployConfig)
    const key = keccak256(stringToHex("missing-key"))

    await expect(config.read.getConfigValue([key])).to.be.rejectedWith(
      "ConfigValueNotSet"
    )
  })

  it("rejects non-owner single writes", async function () {
    const { config, otherAccounts } = await loadFixture(deployConfig)
    const key = keccak256(stringToHex("ethereum-mainnet"))
    const value = toHex(1n, { size: 32 })

    await expect(
      config.write.setConfigValue([key, value], {
        account: otherAccounts[0].account,
      })
    ).to.be.rejectedWith("CallerIsNotAllocatorOwner")
  })

  it("rejects non-owner batch writes", async function () {
    const { config, otherAccounts } = await loadFixture(deployConfig)
    const keys = [keccak256(stringToHex("ethereum-mainnet"))]
    const values = [toHex(1n, { size: 32 })]

    await expect(
      config.write.setConfigValues([keys, values], {
        account: otherAccounts[0].account,
      })
    ).to.be.rejectedWith("CallerIsNotAllocatorOwner")
  })

  it("reverts when batch array lengths do not match", async function () {
    const { config, owner } = await loadFixture(deployConfig)
    const keys = [keccak256(stringToHex("ethereum-mainnet"))]
    const values = [toHex(1n, { size: 32 }), toHex(8453n, { size: 32 })]

    await expect(
      config.write.setConfigValues([keys, values], { account: owner.account })
    ).to.be.rejectedWith("ArrayLengthMismatch")
  })

  it("allows the current allocator owner to update the allocator", async function () {
    const { config, owner, replacementAllocator } =
      await loadFixture(deployConfig)

    await config.write.setAllocator([replacementAllocator.address], {
      account: owner.account,
    })

    expect((await config.read.allocator()).toLowerCase()).to.equal(
      replacementAllocator.address.toLowerCase()
    )
  })

  it("rejects allocator updates from non-owner accounts", async function () {
    const { config, otherAccounts, replacementAllocator } =
      await loadFixture(deployConfig)

    await expect(
      config.write.setAllocator([replacementAllocator.address], {
        account: otherAccounts[0].account,
      })
    ).to.be.rejectedWith("CallerIsNotAllocatorOwner")
  })

  it("uses the replacement allocator owner for subsequent writes", async function () {
    const { config, newOwner, owner, replacementAllocator } =
      await loadFixture(deployConfig)
    const key = keccak256(stringToHex("ethereum-mainnet"))
    const value = toHex(1n, { size: 32 })

    await config.write.setAllocator([replacementAllocator.address], {
      account: owner.account,
    })

    await expect(
      config.write.setConfigValue([key, value], { account: owner.account })
    ).to.be.rejectedWith("CallerIsNotAllocatorOwner")

    await config.write.setConfigValue([key, value], {
      account: newOwner.account,
    })
    expect(await config.read.getConfigValue([key])).to.equal(value)
  })

  it("rejects the zero address as a replacement allocator", async function () {
    const { config, owner } = await loadFixture(deployConfig)

    await expect(
      config.write.setAllocator(
        ["0x0000000000000000000000000000000000000000"],
        {
          account: owner.account,
        }
      )
    ).to.be.rejectedWith("InvalidAllocator")
  })

  it("rejects an EOA as a replacement allocator", async function () {
    const { config, owner, otherAccounts } = await loadFixture(deployConfig)

    await expect(
      config.write.setAllocator([otherAccounts[0].account.address], {
        account: owner.account,
      })
    ).to.be.rejected
  })

  it("rejects a contract without owner() as a replacement allocator", async function () {
    const { config, hub, owner } = await loadFixture(deployConfig)

    await expect(
      config.write.setAllocator([hub.address], {
        account: owner.account,
      })
    ).to.be.rejectedWith("InvalidAllocator")
  })
})
