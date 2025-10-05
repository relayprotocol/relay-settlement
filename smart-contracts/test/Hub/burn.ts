import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect, assert } from "chai"
import hre from "hardhat"
import { keccak256 } from "viem"

describe("burn", function () {
  async function deployHub() {
    const [admin, operatorUser, regularUser] = await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract("Hub", [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    // Add operator role to operatorUser
    const addOperatorHash = await hub.write.grantRole(
      [keccak256("OPERATOR_ROLE"), operatorUser.account.address],
      {
        account: admin.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOperatorHash })

    return {
      admin,
      hub,
      operatorUser,
      publicClient,
      regularUser,
    }
  }

  it("allows an operator to burn tokens from any address", async function () {
    const { hub, operatorUser, regularUser, publicClient } =
      await loadFixture(deployHub)
    const tokenId = 1n
    const amount = 100n

    // First mint some tokens to regularUser
    const mintHash = await hub.write.mint(
      [regularUser.account.address, tokenId, amount],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash })

    // Then burn them
    const burnHash = await hub.write.burn(
      [regularUser.account.address, tokenId, amount],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: burnHash })

    // Verify balance was updated
    const balance = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId,
    ])
    expect(balance).to.equal(0n)
  })

  it("reverts when non-operator tries to burn tokens", async function () {
    const { hub, operatorUser, regularUser, publicClient } =
      await loadFixture(deployHub)
    const tokenId = 1n
    const amount = 100n

    // First mint some tokens to regularUser
    const mintHash = await hub.write.mint(
      [regularUser.account.address, tokenId, amount],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash })

    // Attempt to burn from regular user's perspective
    await expect(
      hub.write.burn([regularUser.account.address, tokenId, amount], {
        account: regularUser.account,
      })
    ).to.be.rejectedWith("AccessControlUnauthorizedAccount")
  })

  it("emits Transfer event with correct parameters", async function () {
    const { hub, operatorUser, regularUser, publicClient } =
      await loadFixture(deployHub)
    const tokenId = 1n
    const amount = 100n

    // First mint some tokens to regularUser
    const mintHash = await hub.write.mint(
      [regularUser.account.address, tokenId, amount],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash })

    // Then burn them
    const burnHash = await hub.write.burn(
      [regularUser.account.address, tokenId, amount],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: burnHash })

    // Get Transfer events
    const logs = await publicClient.getContractEvents({
      abi: hub.abi,
      address: hub.address,
      eventName: "Transfer",
    })

    // Find the Transfer event for this burn
    const transferEvent = logs.find(
      (log) =>
        log.args.id === tokenId &&
        log.args.amount === amount &&
        log.args.to === "0x0000000000000000000000000000000000000000"
    )

    assert(transferEvent !== undefined, "Transfer event not found")
    const event = transferEvent as NonNullable<typeof transferEvent>
    const args = event.args as {
      caller: `0x${string}`
      from: `0x${string}`
      to: `0x${string}`
      id: bigint
      amount: bigint
    }
    expect(args.caller.toLowerCase()).to.equal(
      operatorUser.account.address.toLowerCase()
    )
    expect(args.from.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(args.to.toLowerCase()).to.equal(
      "0x0000000000000000000000000000000000000000".toLowerCase()
    ) // zero address
    expect(args.id).to.equal(tokenId)
    expect(args.amount).to.equal(amount)
  })

  it("reverts when trying to burn more tokens than available", async function () {
    const { hub, operatorUser, regularUser, publicClient } =
      await loadFixture(deployHub)
    const tokenId = 1n
    const mintAmount = 100n
    const burnAmount = 200n // More than minted

    // First mint some tokens to regularUser
    const mintHash = await hub.write.mint(
      [regularUser.account.address, tokenId, mintAmount],
      {
        account: operatorUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash })

    // Attempt to burn more than available
    await expect(
      hub.write.burn([regularUser.account.address, tokenId, burnAmount], {
        account: operatorUser.account,
      })
    ).to.be.rejectedWith("reverted with panic code 0x11")
  })
})
