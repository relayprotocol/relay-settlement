// ABOUTME: Security tests for the EIP-1167 proxy pattern in DepositAddressFactory.
// ABOUTME: Verifies immutable correctness through DELEGATECALL, implementation isolation, and proxy integrity.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { getAddress, parseEther, zeroAddress } from "viem"
import { deployDepositAddressFactory } from "./fixtures"

describe("DepositAddressFactory / proxy security", function () {
  describe("immutables through DELEGATECALL", function () {
    it("should read correct DEPOSITORY through proxy", async function () {
      const { factory, depositor, depository, orderId } = await loadFixture(
        deployDepositAddressFactory
      )

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])

      // Deploy the proxy
      await factory.write.sweep([orderId, depositor.account.address, []])

      // Read DEPOSITORY through the proxy (DELEGATECALL reads from implementation bytecode)
      const proxy = await hre.viem.getContractAt("DepositAddress", predicted)
      const proxyDepository = await proxy.read.DEPOSITORY()

      expect(getAddress(proxyDepository)).to.equal(
        getAddress(depository.address)
      )
    })

    it("should read correct FACTORY through proxy", async function () {
      const { factory, depositor, orderId } = await loadFixture(
        deployDepositAddressFactory
      )

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])

      // Deploy the proxy
      await factory.write.sweep([orderId, depositor.account.address, []])

      // Read FACTORY through the proxy
      const proxy = await hre.viem.getContractAt("DepositAddress", predicted)
      const proxyFactory = await proxy.read.FACTORY()

      expect(getAddress(proxyFactory)).to.equal(getAddress(factory.address))
    })
  })

  describe("implementation isolation", function () {
    it("should revert when calling sweep on the implementation directly", async function () {
      const { sweeper, depositor, orderId, token } = await loadFixture(
        deployDepositAddressFactory
      )

      // Send tokens to the implementation contract
      await token.write.transfer([sweeper.address, 500n])

      // Calling sweep on the implementation directly should revert with OnlyFactory
      // (msg.sender is not the factory)
      await expect(
        sweeper.write.sweep([token.address, depositor.account.address, orderId])
      ).to.be.rejected
    })

    it("should not allow funds on implementation to be swept via proxy", async function () {
      const { factory, sweeper, depositor, orderId, token, publicClient } =
        await loadFixture(deployDepositAddressFactory)

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])

      // Send tokens to the IMPLEMENTATION address (not the proxy)
      await token.write.transfer([sweeper.address, 500n])

      // Sweep the proxy — proxy has no funds, so nothing should be deposited
      const hash = await factory.write.sweep([
        orderId,
        depositor.account.address,
        [token.address],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      // Funds are still stuck on the implementation (not accessible via any proxy)
      const implBalance = await token.read.balanceOf([sweeper.address])
      expect(implBalance).to.equal(500n)

      // Proxy has zero balance
      const proxyBalance = await token.read.balanceOf([predicted])
      expect(proxyBalance).to.equal(0n)
    })

    it("should not allow ETH on implementation to be swept via proxy", async function () {
      const { factory, sweeper, depositor, orderId, deployer, publicClient } =
        await loadFixture(deployDepositAddressFactory)

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])

      // Send ETH to the IMPLEMENTATION address
      await deployer.sendTransaction({
        to: sweeper.address,
        value: parseEther("1"),
      })

      // Sweep the proxy — proxy has no ETH, so nothing should be deposited
      const hash = await factory.write.sweep([
        orderId,
        depositor.account.address,
        [zeroAddress],
      ])
      await publicClient.waitForTransactionReceipt({ hash })

      // ETH is still on the implementation
      const implBalance = await publicClient.getBalance({
        address: sweeper.address,
      })
      expect(implBalance).to.equal(parseEther("1"))

      // Proxy has zero ETH
      const proxyBalance = await publicClient.getBalance({
        address: predicted,
      })
      expect(proxyBalance).to.equal(0n)
    })
  })

  describe("proxy bytecode integrity", function () {
    it("should deploy a valid EIP-1167 minimal proxy", async function () {
      const { factory, depositor, orderId, publicClient } = await loadFixture(
        deployDepositAddressFactory
      )

      const predicted = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])

      // Deploy the proxy
      await factory.write.sweep([orderId, depositor.account.address, []])

      const code = await publicClient.getCode({ address: predicted })
      const implementation = await factory.read.IMPLEMENTATION()

      // Solady's optimized EIP-1167 minimal proxy bytecode format:
      // 0x3d3d3d3d363d3d37363d73{20-byte-address}5af43d3d93803e602a57fd5bf3
      const expectedPrefix = "0x3d3d3d3d363d3d37363d73"
      const expectedSuffix = "5af43d3d93803e602a57fd5bf3"
      const implHex = implementation.slice(2).toLowerCase()

      expect(code!.toLowerCase()).to.equal(
        (expectedPrefix + implHex + expectedSuffix).toLowerCase()
      )
    })

    it("should point all proxies to the same implementation", async function () {
      const { factory, depositor, anyone, orderId, publicClient } =
        await loadFixture(deployDepositAddressFactory)

      const predicted1 = await factory.read.computeDepositAddress([
        orderId,
        depositor.account.address,
      ])
      const predicted2 = await factory.read.computeDepositAddress([
        orderId,
        anyone.account.address,
      ])

      // Deploy two proxies for different depositors
      await factory.write.sweep([orderId, depositor.account.address, []])
      await factory.write.sweep([orderId, anyone.account.address, []])

      const code1 = await publicClient.getCode({ address: predicted1 })
      const code2 = await publicClient.getCode({ address: predicted2 })

      // Both proxies should have identical bytecode (same implementation)
      expect(code1).to.equal(code2)
    })
  })
})
