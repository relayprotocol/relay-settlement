// ABOUTME: Tests for DepositAddressFactory.sweep — the unified deposit flow.
// ABOUTME: Verifies proxy deployment, ERC20/native sweeps, re-sweeps, events, and depositor attribution.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { getAddress, parseEther, zeroAddress } from "viem"
import { deployDepositAddressFactory } from "./fixtures"

describe("DepositAddressFactory / sweep", function () {
  describe("first sweep (deploys proxy)", function () {
    it("should deploy a proxy at the pre-computed address", async function () {
      const { factory, depositor, orderId, publicClient } = await loadFixture(
        deployDepositAddressFactory
      )

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])

      await factory.write.sweep([orderId, depositor.account.address, []])

      const code = await publicClient.getCode({ address: predicted })
      expect(code).to.not.equal(undefined)
      expect(code!.length).to.be.greaterThan(2) // more than "0x"
    })

    it("should emit ProxyDeployed event", async function () {
      const { factory, depositor, orderId, publicClient } = await loadFixture(
        deployDepositAddressFactory
      )

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])

      const hash = await factory.write.sweep([
        orderId,
        depositor.account.address,
        [],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      const proxyDeployedEvents = await factory.getEvents.ProxyDeployed()
      expect(proxyDeployedEvents).to.have.lengthOf(1)
      expect(proxyDeployedEvents[0].args.orderId).to.equal(orderId)
      expect(getAddress(proxyDeployedEvents[0].args.proxyAddress!)).to.equal(
        getAddress(predicted)
      )
    })

    it("should sweep ERC20 tokens sent to the pre-computed address", async function () {
      const { factory, depositor, depository, orderId, token, publicClient } =
        await loadFixture(deployDepositAddressFactory)

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])
      const amount = 1000n

      // Send ERC20 tokens to the predicted address before deployment
      await token.write.transfer([predicted, amount])

      // Sweep (auto-deploys proxy)
      const hash = await factory.write.sweep([
        orderId,
        depositor.account.address,
        [token.address],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      // Verify the depository received the tokens
      const depositoryBalance = await token.read.balanceOf([depository.address])
      expect(depositoryBalance).to.equal(amount)

      // Verify the deposit event was emitted with correct depositor
      const events = await depository.getEvents.RelayErc20Deposit()
      expect(events).to.have.lengthOf(1)
      expect(getAddress(events[0].args.from!)).to.equal(
        getAddress(depositor.account.address)
      )
      expect(events[0].args.amount).to.equal(amount)
      expect(events[0].args.id).to.equal(orderId)
    })

    it("should sweep native ETH sent to the pre-computed address", async function () {
      const {
        factory,
        depositor,
        depository,
        orderId,
        deployer,
        publicClient,
      } = await loadFixture(deployDepositAddressFactory)

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])
      const amount = parseEther("1")

      // Send ETH to the predicted address (no contract there yet)
      await deployer.sendTransaction({ to: predicted, value: amount })

      // Sweep with address(0) indicating native ETH (auto-deploys proxy)
      const hash = await factory.write.sweep([
        orderId,
        depositor.account.address,
        [zeroAddress],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      // Verify the deposit event was emitted
      const events = await depository.getEvents.RelayNativeDeposit()
      expect(events).to.have.lengthOf(1)
      expect(getAddress(events[0].args.from!)).to.equal(
        getAddress(depositor.account.address)
      )
      expect(events[0].args.amount).to.equal(amount)
      expect(events[0].args.id).to.equal(orderId)
    })

    it("should sweep multiple tokens in a single call", async function () {
      const {
        factory,
        depositor,
        depository,
        orderId,
        token,
        deployer,
        publicClient,
      } = await loadFixture(deployDepositAddressFactory)

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])
      const erc20Amount = 500n
      const ethAmount = parseEther("0.5")

      // Send ERC20 + ETH to predicted address
      await token.write.transfer([predicted, erc20Amount])
      await deployer.sendTransaction({ to: predicted, value: ethAmount })

      // Sweep both (auto-deploys proxy)
      const hash = await factory.write.sweep([
        orderId,
        depositor.account.address,
        [token.address, zeroAddress],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      // Verify both deposit events
      const erc20Events = await depository.getEvents.RelayErc20Deposit()
      expect(erc20Events).to.have.lengthOf(1)
      expect(erc20Events[0].args.amount).to.equal(erc20Amount)

      const nativeEvents = await depository.getEvents.RelayNativeDeposit()
      expect(nativeEvents).to.have.lengthOf(1)
      expect(nativeEvents[0].args.amount).to.equal(ethAmount)
    })

    it("should correctly attribute the depositor address", async function () {
      const { factory, anyone, depository, orderId, token, publicClient } =
        await loadFixture(deployDepositAddressFactory)

      // Compute the deposit address for `anyone` as depositor
      const predicted = await factory.read.computeDepositAddress([
        orderId,
        anyone.account.address,
      ])
      const amount = 100n

      // Send tokens to the address bound to `anyone`
      await token.write.transfer([predicted, amount])

      // Sweep — depositor is `anyone`
      const hash = await factory.write.sweep([
        orderId,
        anyone.account.address,
        [token.address],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      // Verify the depositor in the event is `anyone`
      const events = await depository.getEvents.RelayErc20Deposit()
      expect(getAddress(events[0].args.from!)).to.equal(
        getAddress(anyone.account.address)
      )
    })
  })

  describe("re-sweep (already deployed)", function () {
    it("should sweep ERC20 from an already-deployed proxy", async function () {
      const { factory, depositor, depository, orderId, token } =
        await loadFixture(deployDepositAddressFactory)

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])
      const amount1 = 500n
      const amount2 = 300n

      // First sweep (deploys proxy)
      await token.write.transfer([predicted, amount1])
      await factory.write.sweep([
        orderId,
        depositor.account.address,
        [token.address],
      ])

      // Second sweep (proxy already deployed)
      await token.write.transfer([predicted, amount2])
      await factory.write.sweep([
        orderId,
        depositor.account.address,
        [token.address],
      ])

      // Verify the depository received both batches
      const totalBalance = await token.read.balanceOf([depository.address])
      expect(totalBalance).to.equal(amount1 + amount2)
    })

    it("should sweep native ETH from an already-deployed proxy", async function () {
      const {
        factory,
        depositor,
        depository,
        orderId,
        deployer,
        publicClient,
      } = await loadFixture(deployDepositAddressFactory)

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])
      const amount1 = parseEther("1")
      const amount2 = parseEther("0.5")

      // First sweep (deploys proxy)
      await deployer.sendTransaction({ to: predicted, value: amount1 })
      await factory.write.sweep([
        orderId,
        depositor.account.address,
        [zeroAddress],
      ])

      // Second sweep (proxy already deployed)
      await deployer.sendTransaction({ to: predicted, value: amount2 })
      const hash = await factory.write.sweep([
        orderId,
        depositor.account.address,
        [zeroAddress],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      // Verify the depository received both batches
      const depositoryBalance = await publicClient.getBalance({
        address: depository.address,
      })
      expect(depositoryBalance).to.equal(amount1 + amount2)
    })

    it("should not emit ProxyDeployed on re-sweep", async function () {
      const { factory, depositor, orderId, token, publicClient } =
        await loadFixture(deployDepositAddressFactory)

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])

      // First sweep (deploys proxy)
      await factory.write.sweep([orderId, depositor.account.address, []])

      // Send tokens and re-sweep
      await token.write.transfer([predicted, 100n])
      const hash = await factory.write.sweep([
        orderId,
        depositor.account.address,
        [token.address],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      // Only one ProxyDeployed event (from the first sweep)
      const events = await factory.getEvents.ProxyDeployed(
        {},
        { fromBlock: 0n }
      )
      expect(events).to.have.lengthOf(1)
    })
  })
})
