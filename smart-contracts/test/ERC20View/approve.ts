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
    const OPERATOR_ROLE = keccak256('OPERATOR_ROLE' as `0x${string}`)
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
    expect(approvalEvent.args.owner?.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(approvalEvent.args.spender?.toLowerCase()).to.equal(
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

  it('stores allowance in Hub and ERC20View reads from Hub', async function () {
    const { erc20View, hub, publicClient, regularUser, operatorUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Approve via ERC20View
    const approvalAmount = 50n
    const approveTx = await erc20View.write.approve(
      [operatorUser.account.address, approvalAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Check that Hub stores the allowance
    const hubAllowance = await hub.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
      tokenId,
    ])
    expect(hubAllowance).to.equal(approvalAmount)

    // Check that ERC20View reads from Hub
    const erc20ViewAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])
    expect(erc20ViewAllowance).to.equal(approvalAmount)
    expect(erc20ViewAllowance).to.equal(hubAllowance)
  })

  it('Hub.approve triggers ERC20View Approval event', async function () {
    const { erc20View, hub, publicClient, regularUser, operatorUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Approve via Hub directly
    const approvalAmount = 75n
    const approveTx = await hub.write.approve(
      [operatorUser.account.address, tokenId, approvalAmount],
      { account: regularUser.account }
    )
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTx,
    })

    // Check Hub Approval event
    const hubEvents = await publicClient.getContractEvents({
      abi: hub.abi,
      address: hub.address,
      eventName: 'Approval',
      fromBlock: approveReceipt.blockNumber,
      toBlock: approveReceipt.blockNumber,
    })
    expect(hubEvents.length).to.equal(1)
    expect(hubEvents[0].args.owner?.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(hubEvents[0].args.spender?.toLowerCase()).to.equal(
      operatorUser.account.address.toLowerCase()
    )
    expect(hubEvents[0].args.id).to.equal(tokenId)
    expect(hubEvents[0].args.amount).to.equal(approvalAmount)

    // Check ERC20View Approval event (should be triggered by Hub)
    const erc20ViewEvents = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: 'Approval',
      fromBlock: approveReceipt.blockNumber,
      toBlock: approveReceipt.blockNumber,
    })
    expect(erc20ViewEvents.length).to.equal(1)
    expect(erc20ViewEvents[0].args.owner?.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(erc20ViewEvents[0].args.spender?.toLowerCase()).to.equal(
      operatorUser.account.address.toLowerCase()
    )
    expect(erc20ViewEvents[0].args.value).to.equal(approvalAmount)

    // Verify allowance is set correctly
    const allowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])
    expect(allowance).to.equal(approvalAmount)
  })

  it('ERC20View.approve triggers both Hub and ERC20View events', async function () {
    const { erc20View, hub, publicClient, regularUser, operatorUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Approve via ERC20View
    const approvalAmount = 60n
    const approveTx = await erc20View.write.approve(
      [operatorUser.account.address, approvalAmount],
      { account: regularUser.account }
    )
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTx,
    })

    // Check Hub Approval event
    const hubEvents = await publicClient.getContractEvents({
      abi: hub.abi,
      address: hub.address,
      eventName: 'Approval',
      fromBlock: approveReceipt.blockNumber,
      toBlock: approveReceipt.blockNumber,
    })
    expect(hubEvents.length).to.equal(1)
    expect(hubEvents[0].args.owner?.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(hubEvents[0].args.spender?.toLowerCase()).to.equal(
      operatorUser.account.address.toLowerCase()
    )
    expect(hubEvents[0].args.id).to.equal(tokenId)
    expect(hubEvents[0].args.amount).to.equal(approvalAmount)

    // Check ERC20View Approval event
    const erc20ViewEvents = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: 'Approval',
      fromBlock: approveReceipt.blockNumber,
      toBlock: approveReceipt.blockNumber,
    })
    expect(erc20ViewEvents.length).to.equal(1)
    expect(erc20ViewEvents[0].args.owner?.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(erc20ViewEvents[0].args.spender?.toLowerCase()).to.equal(
      operatorUser.account.address.toLowerCase()
    )
    expect(erc20ViewEvents[0].args.value).to.equal(approvalAmount)
  })

  it('allowance consistency across multiple operations', async function () {
    const { erc20View, hub, regularUser, operatorUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // 1. Set initial allowance via ERC20View
    const initialAmount = 100n
    await erc20View.write.approve(
      [operatorUser.account.address, initialAmount],
      { account: regularUser.account }
    )

    // Verify consistency
    let hubAllowance = await hub.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
      tokenId,
    ])
    let erc20ViewAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])
    expect(hubAllowance).to.equal(initialAmount)
    expect(erc20ViewAllowance).to.equal(initialAmount)

    // 2. Update allowance via Hub directly
    const updatedAmount = 200n
    await hub.write.approve(
      [operatorUser.account.address, tokenId, updatedAmount],
      { account: regularUser.account }
    )

    // Verify consistency after Hub update
    hubAllowance = await hub.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
      tokenId,
    ])
    erc20ViewAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])
    expect(hubAllowance).to.equal(updatedAmount)
    expect(erc20ViewAllowance).to.equal(updatedAmount)

    // 3. Reset to zero via ERC20View
    await erc20View.write.approve([operatorUser.account.address, 0n], {
      account: regularUser.account,
    })

    // Verify final consistency
    hubAllowance = await hub.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
      tokenId,
    ])
    erc20ViewAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])
    expect(hubAllowance).to.equal(0n)
    expect(erc20ViewAllowance).to.equal(0n)
  })

  it('prevents unauthorized calls to Hub.approveFor', async function () {
    const { hub, regularUser, operatorUser, anotherUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Try to call approveFor directly from a non-ERC20View address
    await expect(
      hub.write.approveFor(
        [
          regularUser.account.address,
          operatorUser.account.address,
          tokenId,
          100n,
        ],
        { account: anotherUser.account }
      )
    ).to.be.rejectedWith('OnlyERC20ViewCanCallApproveFor')
  })

  it('prevents non-owner from setting allowance via ERC20View', async function () {
    const { erc20View, operatorUser, anotherUser } = await loadFixture(
      deployHubWithERC20View
    )

    // anotherUser tries to approve on behalf of regularUser without permission
    const approveTx = erc20View.write.approve(
      [operatorUser.account.address, 100n],
      { account: anotherUser.account }
    )

    // This should work but set allowance for anotherUser, not regularUser
    await expect(approveTx).to.not.be.rejected

    // Verify the allowance is set for anotherUser, not regularUser
    const allowance = await erc20View.read.allowance([
      anotherUser.account.address, // Owner is anotherUser
      operatorUser.account.address,
    ])
    expect(allowance).to.equal(100n)
  })

  it('handles maximum allowance correctly', async function () {
    const { erc20View, publicClient, regularUser, operatorUser } =
      await loadFixture(deployHubWithERC20View)

    // Set maximum allowance
    const maxAllowance = BigInt(
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    )
    const approveTx = await erc20View.write.approve(
      [operatorUser.account.address, maxAllowance],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Check allowance
    const allowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])

    expect(allowance).to.equal(maxAllowance)
  })

  it('handles zero allowance correctly', async function () {
    const { erc20View, hub, publicClient, regularUser, operatorUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // First set a non-zero allowance
    await erc20View.write.approve([operatorUser.account.address, 100n], {
      account: regularUser.account,
    })

    // Then set to zero
    const approveTx = await erc20View.write.approve(
      [operatorUser.account.address, 0n],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Check both Hub and ERC20View show zero
    const hubAllowance = await hub.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
      tokenId,
    ])
    const erc20ViewAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
    ])

    expect(hubAllowance).to.equal(0n)
    expect(erc20ViewAllowance).to.equal(0n)
  })

  it('preserves allowance data integrity across different token IDs', async function () {
    const { erc20View, hub, operatorUser, regularUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Create a second token
    const tokenId2 = 2n
    await hub.write.mint([regularUser.account.address, tokenId2, 100n], {
      account: operatorUser.account,
    })

    // Set different allowances for different tokens
    await erc20View.write.approve([operatorUser.account.address, 50n], {
      account: regularUser.account,
    })

    // Set allowance for token2 via Hub directly
    await hub.write.approve([operatorUser.account.address, tokenId2, 75n], {
      account: regularUser.account,
    })

    // Verify allowances are isolated
    const allowanceToken1 = await hub.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
      tokenId,
    ])
    const allowanceToken2 = await hub.read.allowance([
      regularUser.account.address,
      operatorUser.account.address,
      tokenId2,
    ])

    expect(allowanceToken1).to.equal(50n)
    expect(allowanceToken2).to.equal(75n)
  })
})
