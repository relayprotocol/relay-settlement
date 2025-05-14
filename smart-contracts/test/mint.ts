import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect, assert } from 'chai'
import hre from 'hardhat'

describe('mint', function () {
  async function deployHub() {
    const [admin, oracleUser, regularUser] = await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    // Add oracle role to oracleUser
    const addOracleHash = await hub.write.addOracle(
      [oracleUser.account.address],
      {
        account: admin.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOracleHash })

    return {
      admin,
      hub,
      oracleUser,
      publicClient,
      regularUser,
    }
  }
  it('allows oracle to mint tokens to any address', async function () {
    const { hub, oracleUser, regularUser, publicClient } =
      await loadFixture(deployHub)
    const tokenId = 1n
    const amount = 100n

    // Mint tokens from oracle user's perspective
    const mintHash = await hub.write.mint(
      [regularUser.account.address, tokenId, amount],
      {
        account: oracleUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash })

    // Verify balance was updated
    const balance = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId,
    ])
    expect(balance).to.equal(amount)
  })

  it('reverts when non-oracle tries to mint tokens', async function () {
    const { hub, regularUser } = await loadFixture(deployHub)
    const tokenId = 1n
    const amount = 100n

    // Attempt to mint from regular user's perspective
    await expect(
      hub.write.mint([regularUser.account.address, tokenId, amount], {
        account: regularUser.account,
      })
    ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
  })

  it('emits Transfer event with correct parameters', async function () {
    const { hub, oracleUser, regularUser, publicClient } =
      await loadFixture(deployHub)
    const tokenId = 1n
    const amount = 100n

    // Mint tokens and get transaction receipt
    const mintHash = await hub.write.mint(
      [regularUser.account.address, tokenId, amount],
      {
        account: oracleUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash })

    // Get Transfer events
    const logs = await publicClient.getContractEvents({
      abi: hub.abi,
      address: hub.address,
      eventName: 'Transfer',
    })

    // Find the Transfer event for this mint
    const transferEvent = logs.find(
      (log) => log.args.id === tokenId && log.args.amount === amount
    )

    const event = transferEvent as NonNullable<typeof transferEvent>
    const args = event.args as {
      caller: `0x${string}`
      from: `0x${string}`
      to: `0x${string}`
      id: bigint
      amount: bigint
    }
    expect(args.caller.toLowerCase()).to.equal(
      oracleUser.account.address.toLowerCase()
    )
    expect(args.from.toLowerCase()).to.equal(
      '0x0000000000000000000000000000000000000000'.toLowerCase()
    ) // zero address
    expect(args.to.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(args.id).to.equal(tokenId)
    expect(args.amount).to.equal(amount)
  })

  it('allows minting multiple tokens with different IDs', async function () {
    const { hub, oracleUser, regularUser, publicClient } =
      await loadFixture(deployHub)
    const tokenId1 = 1n
    const tokenId2 = 2n
    const amount1 = 100n
    const amount2 = 200n

    // Mint first token
    const mintHash1 = await hub.write.mint(
      [regularUser.account.address, tokenId1, amount1],
      {
        account: oracleUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash1 })

    // Mint second token
    const mintHash2 = await hub.write.mint(
      [regularUser.account.address, tokenId2, amount2],
      {
        account: oracleUser.account,
      }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintHash2 })

    // Verify balances
    const balance1 = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId1,
    ])
    const balance2 = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId2,
    ])
    expect(balance1).to.equal(amount1)
    expect(balance2).to.equal(amount2)
  })
})
