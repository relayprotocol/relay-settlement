import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { Address, keccak256 } from "viem"

describe("ERC20View TransferFrom", function () {
  async function deployHubWithERC20View() {
    const [admin, operatorUser, regularUser, anotherUser] =
      await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract("RelayHub", [
      admin.account.address,
    ])
    const publicClient = await hre.viem.getPublicClient()

    // Add operator role to operatorUser
    const OPERATOR_ROLE = keccak256("OPERATOR_ROLE" as `0x${string}`)
    const addOperatorHash = await hub.write.grantRole(
      [OPERATOR_ROLE, operatorUser.account.address as Address],
      { account: admin.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOperatorHash })

    // Define tokenId
    const tokenId = 1n

    // Mint tokens to regularUser - this will automatically create the ERC20View
    const mintTx = await hub.write.mint(
      [regularUser.account.address, tokenId, 1000n],
      { account: operatorUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintTx })

    // Get ERC20View address from mapping
    const erc20ViewAddress = (await hub.read.erc20Views([tokenId])) as Address

    // Get ERC20View contract
    const erc20View = await hre.viem.getContractAt(
      "ERC20View",
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

  it("transfers tokens correctly with valid allowance", async function () {
    const { erc20View, hub, publicClient, regularUser, anotherUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Approve anotherUser to spend tokens
    const approvalAmount = 100n
    const approveTx = await erc20View.write.approve(
      [anotherUser.account.address, approvalAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Check initial balances
    const initialFromBalance = await hub.read.balanceOf([
      regularUser.account.address,
      tokenId,
    ])
    const initialToBalance = await hub.read.balanceOf([
      anotherUser.account.address,
      tokenId,
    ])

    // Transfer tokens via transferFrom
    const transferAmount = 50n
    const transferTx = await erc20View.write.transferFrom(
      [
        regularUser.account.address,
        anotherUser.account.address,
        transferAmount,
      ],
      { account: anotherUser.account }
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

  it("prevents unauthorized transferFrom without allowance", async function () {
    const { erc20View, regularUser, anotherUser } = await loadFixture(
      deployHubWithERC20View
    )

    // Try to transfer tokens without allowance - should revert with arithmetic error
    const transferAmount = 100n
    await expect(
      erc20View.write.transferFrom(
        [
          regularUser.account.address,
          anotherUser.account.address,
          transferAmount,
        ],
        { account: anotherUser.account }
      )
    ).to.be.rejected
  })

  it("prevents transferFrom when allowance is insufficient", async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Give small allowance
    const allowanceAmount = 50n
    const approveTx = await erc20View.write.approve(
      [anotherUser.account.address, allowanceAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Try to transfer more than allowed - should revert with arithmetic error
    const transferAmount = allowanceAmount + 1n
    await expect(
      erc20View.write.transferFrom(
        [
          regularUser.account.address,
          anotherUser.account.address,
          transferAmount,
        ],
        { account: anotherUser.account }
      )
    ).to.be.rejected
  })

  it("properly updates allowance after successful transferFrom", async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Give allowance
    const allowanceAmount = 100n
    const approveTx = await erc20View.write.approve(
      [anotherUser.account.address, allowanceAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Transfer valid amount
    const transferAmount = 30n
    const transferTx = await erc20View.write.transferFrom(
      [
        regularUser.account.address,
        anotherUser.account.address,
        transferAmount,
      ],
      { account: anotherUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: transferTx })

    // Check allowance was properly updated
    const finalAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      anotherUser.account.address,
    ])
    expect(finalAllowance).to.equal(allowanceAmount - transferAmount)
  })

  it("does not update unlimited allowance (type(uint256).max)", async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Give unlimited allowance
    const unlimitedAllowance = BigInt(
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    )
    const approveTx = await erc20View.write.approve(
      [anotherUser.account.address, unlimitedAllowance],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Transfer amount
    const transferAmount = 100n
    const transferTx = await erc20View.write.transferFrom(
      [
        regularUser.account.address,
        anotherUser.account.address,
        transferAmount,
      ],
      { account: anotherUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: transferTx })

    // Check unlimited allowance remains unchanged
    const finalAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      anotherUser.account.address,
    ])
    expect(finalAllowance).to.equal(unlimitedAllowance)
  })

  it("allows owner to transfer without allowance check", async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Owner transfers own tokens (no allowance needed)
    const transferAmount = 50n
    const transferTx = await erc20View.write.transferFrom(
      [
        regularUser.account.address,
        anotherUser.account.address,
        transferAmount,
      ],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: transferTx })

    // Verify transfer succeeded
    const finalBalance = await erc20View.read.balanceOf([
      anotherUser.account.address,
    ])
    expect(finalBalance).to.equal(transferAmount)
  })

  it("maintains allowance consistency between Hub and ERC20View", async function () {
    const { erc20View, hub, publicClient, regularUser, anotherUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Set allowance via ERC20View
    const allowanceAmount = 200n
    const approveTx = await erc20View.write.approve(
      [anotherUser.account.address, allowanceAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Transfer via ERC20View
    const transferAmount = 75n
    const transferTx = await erc20View.write.transferFrom(
      [
        regularUser.account.address,
        anotherUser.account.address,
        transferAmount,
      ],
      { account: anotherUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: transferTx })

    // Check both Hub and ERC20View show same updated allowance
    const hubAllowance = await hub.read.allowance([
      regularUser.account.address,
      anotherUser.account.address,
      tokenId,
    ])
    const erc20ViewAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      anotherUser.account.address,
    ])

    const expectedAllowance = allowanceAmount - transferAmount
    expect(hubAllowance).to.equal(expectedAllowance)
    expect(erc20ViewAllowance).to.equal(expectedAllowance)
  })

  it("emits Transfer event with correct parameters", async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Approve anotherUser to spend tokens
    const approveTx = await erc20View.write.approve(
      [anotherUser.account.address, 100n],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Transfer tokens via transferFrom
    const transferAmount = 25n
    const transferTx = await erc20View.write.transferFrom(
      [
        regularUser.account.address,
        anotherUser.account.address,
        transferAmount,
      ],
      { account: anotherUser.account }
    )
    const transferReceipt = await publicClient.waitForTransactionReceipt({
      hash: transferTx,
    })

    // Check for Transfer event
    const events = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: "Transfer",
      fromBlock: transferReceipt.blockNumber,
      toBlock: transferReceipt.blockNumber,
    })

    expect(events.length).to.equal(1)
    const transferEvent = events[0]
    expect(transferEvent.args.from?.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(transferEvent.args.to?.toLowerCase()).to.equal(
      anotherUser.account.address.toLowerCase()
    )
    expect(transferEvent.args.value).to.equal(transferAmount)
  })

  it("handles zero amount transfer correctly", async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Give some allowance
    const approveTx = await erc20View.write.approve(
      [anotherUser.account.address, 100n],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Transfer zero amount
    const transferTx = await erc20View.write.transferFrom(
      [regularUser.account.address, anotherUser.account.address, 0n],
      { account: anotherUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: transferTx })

    // Allowance should remain unchanged
    const finalAllowance = await erc20View.read.allowance([
      regularUser.account.address,
      anotherUser.account.address,
    ])
    expect(finalAllowance).to.equal(100n)
  })
})
