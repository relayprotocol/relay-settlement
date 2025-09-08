import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { Address, keccak256 } from 'viem'

describe('ERC20View Transfer', function () {
  async function deployHubWithERC20View() {
    const [admin, operatorUser, regularUser, anotherUser] =
      await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    // Add operator role to operatorUser
    const OPERATOR_ROLE = keccak256('OPERATOR_ROLE')
    const addOperatorHash = await hub.write.grantRole(
      [OPERATOR_ROLE, operatorUser.account.address as Address],
      { account: admin.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOperatorHash })

    // Define tokenId
    const tokenId = 1n

    // Mint tokens to regularUser - this will automatically create the ERC20View
    const mintTx = await hub.write.mint(
      [regularUser.account.address, tokenId, 100n],
      { account: operatorUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintTx })

    // Get ERC20View address from mapping
    const erc20ViewAddress = (await hub.read.erc20Views([tokenId])) as Address

    // Get ERC20View contract
    const erc20View = await hre.viem.getContractAt(
      'ERC20View',
      erc20ViewAddress
    )

    return {
      admin,
      anotherUser,
      erc20View,
      erc20ViewAddress,
      hub,
      publicClient,
      regularUser,
      tokenId,
    }
  }

  it('transfers tokens correctly via ERC20View', async function () {
    const { erc20View, hub, publicClient, regularUser, anotherUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Check initial balances
    const initialFromBalance = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId,
    ])
    const initialToBalance = await hub.read.balanceOf([
      anotherUser.account.address,
      tokenId,
    ])

    // Transfer tokens via ERC20View
    const transferAmount = 25n
    const transferTx = await erc20View.write.transfer(
      [anotherUser.account.address, transferAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: transferTx })

    // Check final balances
    const finalFromBalance = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId,
    ])
    const finalToBalance = await hub.read.balanceOf([
      anotherUser.account.address,
      tokenId,
    ])

    // Verify balances changed correctly
    expect(finalFromBalance).to.equal(initialFromBalance - transferAmount)
    expect(finalToBalance).to.equal(initialToBalance + transferAmount)
  })

  it('reverts when trying to transfer more than balance', async function () {
    const { erc20View, hub, regularUser, anotherUser } = await loadFixture(
      deployHubWithERC20View
    )

    // Get current balance
    const currentBalance = await hub.read.balanceOf([
      regularUser.account.address,
      1n,
    ])

    // Try to transfer more than balance
    const excessAmount = currentBalance + 1n

    // Expect transaction to revert
    await expect(
      erc20View.write.transfer([anotherUser.account.address, excessAmount], {
        account: regularUser.account,
      })
    ).to.be.rejected
  })

  it('emits Transfer event with correct parameters', async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Transfer tokens
    const transferAmount = 15n
    const transferTx = await erc20View.write.transfer(
      [anotherUser.account.address, transferAmount],
      { account: regularUser.account }
    )
    const transferReceipt = await publicClient.waitForTransactionReceipt({
      hash: transferTx,
    })

    // Check for Transfer event
    const events = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: 'Transfer',
      fromBlock: transferReceipt.blockNumber,
      toBlock: transferReceipt.blockNumber,
    })

    expect(events.length).to.equal(1)
    const transferEvent = events[0]
    expect(transferEvent.args.from.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(transferEvent.args.to.toLowerCase()).to.equal(
      anotherUser.account.address.toLowerCase()
    )
    expect(transferEvent.args.value).to.equal(transferAmount)
  })

  it('allows transfer to zero address (burn)', async function () {
    const { erc20View, hub, publicClient, regularUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Check initial balance
    const initialBalance = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId,
    ])

    // Transfer tokens to zero address (burn)
    const burnAmount = 10n
    const zeroAddress = '0x0000000000000000000000000000000000000000'
    const transferTx = await erc20View.write.transfer(
      [zeroAddress, burnAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: transferTx })

    // Check final balance
    const finalBalance = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId,
    ])

    // Verify balance decreased
    expect(finalBalance).to.equal(initialBalance - burnAmount)
  })
})
