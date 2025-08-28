import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { Address, keccak256 } from 'viem'

describe('ERC20View Direct Events', function () {
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
      operatorUser,
      publicClient,
      regularUser,
      tokenId,
    }
  }

  it('emits Approval event on ERC20View approve', async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Approve anotherUser to spend tokens
    const approvalAmount = 50n
    const approveTx = await erc20View.write.approve(
      [anotherUser.account.address, approvalAmount],
      { account: regularUser.account }
    )
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTx,
    })

    // Check for Approval event
    const events = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: 'Approval',
      fromBlock: approveReceipt.blockNumber,
      toBlock: approveReceipt.blockNumber,
    })

    expect(events.length).to.equal(1)
    const approvalEvent = events[0]
    expect(approvalEvent.args.owner.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(approvalEvent.args.spender.toLowerCase()).to.equal(
      anotherUser.account.address.toLowerCase()
    )
    expect(approvalEvent.args.value).to.equal(approvalAmount)
  })

  it('emits Transfer event on ERC20View transfer', async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Transfer tokens directly via ERC20View
    const transferAmount = 25n
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

  it('emits Transfer event on ERC20View transferFrom', async function () {
    const { erc20View, publicClient, regularUser, anotherUser, admin } =
      await loadFixture(deployHubWithERC20View)

    // Approve admin to spend tokens
    const approvalAmount = 50n
    const approveTx = await erc20View.write.approve(
      [admin.account.address, approvalAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Transfer tokens via transferFrom
    const transferAmount = 25n
    const transferFromTx = await erc20View.write.transferFrom(
      [
        regularUser.account.address,
        anotherUser.account.address,
        transferAmount,
      ],
      { account: admin.account }
    )
    const transferFromReceipt = await publicClient.waitForTransactionReceipt({
      hash: transferFromTx,
    })

    // Check for Transfer event
    const events = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: 'Transfer',
      fromBlock: transferFromReceipt.blockNumber,
      toBlock: transferFromReceipt.blockNumber,
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
})
