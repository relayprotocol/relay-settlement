// ABOUTME: Edge case and security tests for DepositAddressFactory.
// ABOUTME: Tests zero balance, anti-griefing, depositor binding, front-running, and access control.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { getAddress, parseEther, zeroAddress } from "viem"
import { deployDepositAddressFactory } from "./fixtures"

describe("DepositAddressFactory / edge cases", function () {
  it("should succeed when sweeping a token with zero balance", async function () {
    const { factory, depositor, depository, orderId, token, publicClient } =
      await loadFixture(deployDepositAddressFactory)

    // Sweep without sending any tokens first
    const hash = await factory.write.sweep([
      orderId,
      depositor.account.address,
      [token.address],
    ])
    await publicClient.waitForTransactionReceipt({ hash })

    // No deposit events should have been emitted
    const events = await depository.getEvents.RelayErc20Deposit()
    expect(events).to.have.lengthOf(0)
  })

  it("should succeed when sweeping native ETH with zero balance", async function () {
    const { factory, depositor, depository, orderId, publicClient } =
      await loadFixture(deployDepositAddressFactory)

    // Sweep without sending any ETH first
    const hash = await factory.write.sweep([
      orderId,
      depositor.account.address,
      [zeroAddress],
    ])
    await publicClient.waitForTransactionReceipt({ hash })

    // No deposit events should have been emitted
    const events = await depository.getEvents.RelayNativeDeposit()
    expect(events).to.have.lengthOf(0)
  })

  it("should accept ETH after deployment (anti-griefing)", async function () {
    const { factory, depositor, orderId, deployer, publicClient } =
      await loadFixture(deployDepositAddressFactory)

    const predicted = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])
    const amount = parseEther("1")

    // Deploy first (attacker griefs by deploying early)
    await factory.write.sweep([orderId, depositor.account.address, []])

    // Send ETH after deployment — proxy's receive() should accept it
    await deployer.sendTransaction({ to: predicted, value: amount })

    // Verify the proxy has the ETH
    const balance = await publicClient.getBalance({ address: predicted })
    expect(balance).to.equal(amount)
  })

  it("should not sweep funds when called with wrong depositor", async function () {
    const { factory, depositor, anyone, orderId, token, publicClient } =
      await loadFixture(deployDepositAddressFactory)

    // Compute address bound to `depositor`
    const predicted = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])

    // Send tokens to the depositor-bound address
    await token.write.transfer([predicted, 500n])

    // Attacker tries to sweep with `anyone` as depositor — deploys a different proxy (no funds)
    const hash = await factory.write.sweep([
      orderId,
      anyone.account.address,
      [token.address],
    ])
    await publicClient.waitForTransactionReceipt({ hash })

    // Funds are still at the original address (not swept)
    const balance = await token.read.balanceOf([predicted])
    expect(balance).to.equal(500n)
  })

  it("should not allow front-running to block the legitimate sweep", async function () {
    const {
      factory,
      depositor,
      anyone,
      depository,
      orderId,
      token,
      publicClient,
    } = await loadFixture(deployDepositAddressFactory)

    const predicted = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])

    // User sends funds to their depositor-bound address
    await token.write.transfer([predicted, 1000n])

    // Attacker front-runs with wrong depositor — deploys a *different* proxy (empty)
    await factory.write.sweep([
      orderId,
      anyone.account.address,
      [token.address],
    ])

    // Victim's sweep still works — targets the correct proxy
    const hash = await factory.write.sweep([
      orderId,
      depositor.account.address,
      [token.address],
    ])
    await publicClient.waitForTransactionReceipt({ hash })

    // Funds were swept with the correct depositor attribution
    const events = await depository.getEvents.RelayErc20Deposit(
      {},
      { fromBlock: 0n }
    )
    // Only 1 deposit event (attacker's proxy had zero balance)
    expect(events).to.have.lengthOf(1)
    expect(getAddress(events[0].args.from!)).to.equal(
      getAddress(depositor.account.address)
    )
    expect(events[0].args.amount).to.equal(1000n)
  })

  it("should revert when attacker calls proxy sweep directly", async function () {
    const { factory, depositor, anyone, orderId, token } = await loadFixture(
      deployDepositAddressFactory
    )

    const predicted = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])

    // Deploy the proxy via legitimate sweep (empty tokens to just deploy)
    await factory.write.sweep([orderId, depositor.account.address, []])

    // Send tokens to the deployed proxy
    await token.write.transfer([predicted, 1000n])

    // Attacker tries to call proxy's sweep() directly — reverts with OnlyFactory
    const proxy = await hre.viem.getContractAt("DepositAddress", predicted)
    await expect(
      proxy.write.sweep([token.address, anyone.account.address, orderId], {
        account: anyone.account,
      })
    ).to.be.rejected

    // Funds are still in the proxy (not swept)
    const balance = await token.read.balanceOf([predicted])
    expect(balance).to.equal(1000n)
  })

  it("should handle address(0) passed multiple times in tokens array", async function () {
    const { factory, depositor, depository, orderId, deployer, publicClient } =
      await loadFixture(deployDepositAddressFactory)

    const predicted = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])
    const amount = parseEther("1")

    // Send ETH to predicted address
    await deployer.sendTransaction({ to: predicted, value: amount })

    // Sweep with address(0) twice
    const hash = await factory.write.sweep([
      orderId,
      depositor.account.address,
      [zeroAddress, zeroAddress],
    ])
    await publicClient.waitForTransactionReceipt({ hash })

    // Only first sweep should deposit (second has zero balance)
    const events = await depository.getEvents.RelayNativeDeposit()
    expect(events).to.have.lengthOf(1)
    expect(events[0].args.amount).to.equal(amount)
  })
})
