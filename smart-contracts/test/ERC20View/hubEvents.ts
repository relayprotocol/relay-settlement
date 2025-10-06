import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { Address, keccak256 } from "viem"

describe("ERC20View Hub Events", function () {
  async function deployHubWithERC20View() {
    const [admin, operatorUser, regularUser, anotherUser] =
      await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract("RelayHub", [
      admin.account.address,
    ])
    const publicClient = await hre.viem.getPublicClient()

    // Add operator role to operatorUser
    const OPERATOR_ROLE = keccak256("OPERATOR_ROLE")
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
      operatorUser,
      publicClient,
      regularUser,
      tokenId,
    }
  }

  it("emits Transfer event on Hub transfer", async function () {
    const { hub, erc20View, publicClient, regularUser, anotherUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Transfer tokens from regularUser to anotherUser
    const transferAmount = 10n
    const transferTx = await hub.write.transfer(
      [anotherUser.account.address, tokenId, transferAmount],
      { account: regularUser.account }
    )
    const transferReceipt = await publicClient.waitForTransactionReceipt({
      hash: transferTx,
    })

    // Check for Transfer event from ERC20View
    const events = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: "Transfer",
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

  it("emits Transfer event on Hub transferFrom", async function () {
    const { hub, erc20View, publicClient, regularUser, anotherUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Approve anotherUser
    const approvalAmount = 50n
    const approveTx = await hub.write.approve(
      [anotherUser.account.address, tokenId, approvalAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // Transfer tokens using transferFrom
    const transferAmount = 10n
    const transferFromTx = await hub.write.transferFrom(
      [
        regularUser.account.address,
        anotherUser.account.address,
        tokenId,
        transferAmount,
      ],
      { account: anotherUser.account }
    )
    const transferFromReceipt = await publicClient.waitForTransactionReceipt({
      hash: transferFromTx,
    })

    // Check for Transfer event from ERC20View
    const events = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: "Transfer",
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

  it("emits Transfer event on Hub mint", async function () {
    const { hub, erc20View, publicClient, regularUser, operatorUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Mint more tokens
    const mintAmount = 50n
    const mintTx = await hub.write.mint(
      [regularUser.account.address, tokenId, mintAmount],
      { account: operatorUser.account }
    )
    const mintReceipt = await publicClient.waitForTransactionReceipt({
      hash: mintTx,
    })

    // Check for Transfer event from ERC20View
    const events = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: "Transfer",
      fromBlock: mintReceipt.blockNumber,
      toBlock: mintReceipt.blockNumber,
    })

    expect(events.length).to.equal(1)
    const transferEvent = events[0]
    expect(transferEvent.args.from.toLowerCase()).to.equal(
      "0x0000000000000000000000000000000000000000"
    )
    expect(transferEvent.args.to.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(transferEvent.args.value).to.equal(mintAmount)
  })

  it("emits Transfer event on Hub burn", async function () {
    const { hub, erc20View, publicClient, regularUser, operatorUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // Burn tokens
    const burnAmount = 10n
    const burnTx = await hub.write.burn(
      [regularUser.account.address, tokenId, burnAmount],
      { account: operatorUser.account }
    )
    const burnReceipt = await publicClient.waitForTransactionReceipt({
      hash: burnTx,
    })

    // Check for Transfer event from ERC20View
    const events = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: "Transfer",
      fromBlock: burnReceipt.blockNumber,
      toBlock: burnReceipt.blockNumber,
    })

    expect(events.length).to.equal(1)
    const transferEvent = events[0]
    expect(transferEvent.args.from.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(transferEvent.args.to.toLowerCase()).to.equal(
      "0x0000000000000000000000000000000000000000"
    )
    expect(transferEvent.args.value).to.equal(burnAmount)
  })

  it("emits multiple Transfer events for multiple Hub transfers", async function () {
    const { hub, erc20View, publicClient, regularUser, anotherUser, tokenId } =
      await loadFixture(deployHubWithERC20View)

    // First transfer
    const firstTransferAmount = 10n
    const firstTransferTx = await hub.write.transfer(
      [anotherUser.account.address, tokenId, firstTransferAmount],
      { account: regularUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: firstTransferTx })

    // Second transfer
    const secondTransferAmount = 15n
    const secondTransferTx = await hub.write.transfer(
      [anotherUser.account.address, tokenId, secondTransferAmount],
      { account: regularUser.account }
    )
    const secondTransferReceipt = await publicClient.waitForTransactionReceipt({
      hash: secondTransferTx,
    })

    // Get all Transfer events
    const allEvents = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: "Transfer",
      fromBlock: 0n,
      toBlock: secondTransferReceipt.blockNumber,
    })

    // We should have at least 3 events: initial mint + 2 transfers
    expect(allEvents.length).to.be.at.least(3)

    // Check the last two events are our transfers
    const lastTwoEvents = allEvents.slice(-2)

    // First transfer event
    expect(lastTwoEvents[0].args.from.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(lastTwoEvents[0].args.to.toLowerCase()).to.equal(
      anotherUser.account.address.toLowerCase()
    )
    expect(lastTwoEvents[0].args.value).to.equal(firstTransferAmount)

    // Second transfer event
    expect(lastTwoEvents[1].args.from.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(lastTwoEvents[1].args.to.toLowerCase()).to.equal(
      anotherUser.account.address.toLowerCase()
    )
    expect(lastTwoEvents[1].args.value).to.equal(secondTransferAmount)
  })

  it("does not emit duplicate events when msg.sender is the ERC20View itself", async function () {
    const { erc20View, publicClient, regularUser, anotherUser } =
      await loadFixture(deployHubWithERC20View)

    // Transfer tokens using ERC20View (which will call Hub's transferFrom)
    const transferAmount = 10n
    const transferTx = await erc20View.write.transfer(
      [anotherUser.account.address, transferAmount],
      { account: regularUser.account }
    )
    const transferReceipt = await publicClient.waitForTransactionReceipt({
      hash: transferTx,
    })

    // Check that only one Transfer event from ERC20View was emitted
    const erc20ViewTransferEvents = await publicClient.getContractEvents({
      abi: erc20View.abi,
      address: erc20View.address,
      eventName: "Transfer",
      fromBlock: transferReceipt.blockNumber,
      toBlock: transferReceipt.blockNumber,
    })

    expect(erc20ViewTransferEvents.length).to.equal(1)
    expect(erc20ViewTransferEvents[0].args.from.toLowerCase()).to.equal(
      regularUser.account.address.toLowerCase()
    )
    expect(erc20ViewTransferEvents[0].args.to.toLowerCase()).to.equal(
      anotherUser.account.address.toLowerCase()
    )
    expect(erc20ViewTransferEvents[0].args.value).to.equal(transferAmount)
  })
})
