import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { Address, keccak256 } from 'viem'

describe('ERC20View Approve', function () {
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

  it('approves spender correctly', async function () {
    const { erc20View, publicClient, regularUser, operatorUser } =
      await loadFixture(deployHubWithERC20View)

    // Approve operatorUser to spend tokens
    const approvalAmount = 50n
    const approveTx = await erc20View.write.approve(
      [operatorUser.account.address, approvalAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Check allowance
    const allowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])

    expect(allowance).to.equal(approvalAmount)
  })

  it('updates allowance when approve is called again', async function () {
    const { erc20View, publicClient, regularUser, operatorUser } =
      await loadFixture(deployHubWithERC20View)

    // First approval
    const firstApprovalAmount = 50n
    const firstApproveTx = await erc20View.write.approve(
      [operatorUser.account.address, firstApprovalAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: firstApproveTx })

    // Check first allowance
    const firstAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])
    expect(firstAllowance).to.equal(firstApprovalAmount)

    // Second approval with different amount
    const secondApprovalAmount = 75n
    const secondApproveTx = await erc20View.write.approve(
      [operatorUser.account.address, secondApprovalAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: secondApproveTx })

    // Check updated allowance
    const updatedAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])
    expect(updatedAllowance).to.equal(secondApprovalAmount)
  })

  it('emits Approval event with correct parameters', async function () {
    const { erc20View, publicClient, regularUser, operatorUser } =
      await loadFixture(deployHubWithERC20View)

    // Approve operatorUser to spend tokens
    const approvalAmount = 50n
    const approveTx = await erc20View.write.approve(
      [operatorUser.account.address, approvalAmount],
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
      operatorUser.account.address.toLowerCase()
    )
    expect(approvalEvent.args.value).to.equal(approvalAmount)
  })

  it('allows approval to zero address', async function () {
    const { erc20View, publicClient, regularUser } = await loadFixture(
      deployHubWithERC20View
    )

    // Approve zero address
    const approvalAmount = 50n
    const zeroAddress = '0x0000000000000000000000000000000000000000'
    const approveTx = await erc20View.write.approve(
      [zeroAddress, approvalAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Check allowance
    const allowance = await erc20View.read.allowance([
      regularUser.account.address,
      zeroAddress,
    ])

    expect(allowance).to.equal(approvalAmount)
  })
})
