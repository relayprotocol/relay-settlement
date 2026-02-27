// ABOUTME: Tests for DepositAddressFactory.computeDepositAddress determinism.
// ABOUTME: Verifies address computation is deterministic, unique per orderId/depositor, and non-zero.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { keccak256, toHex, zeroAddress } from "viem"
import { deployDepositAddressFactory } from "./fixtures"

describe("DepositAddressFactory / computeDepositAddress", function () {
  it("should return a deterministic address for an orderId and depositor", async function () {
    const { factory, orderId, depositor } = await loadFixture(
      deployDepositAddressFactory
    )

    const addr1 = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])
    const addr2 = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])

    expect(addr1).to.equal(addr2)
  })

  it("should return different addresses for different orderIds", async function () {
    const { factory, depositor } = await loadFixture(
      deployDepositAddressFactory
    )

    const orderId1 = keccak256(toHex("order-1"))
    const orderId2 = keccak256(toHex("order-2"))

    const addr1 = await factory.read.computeDepositAddress([
      orderId1,
      depositor.account.address,
    ])
    const addr2 = await factory.read.computeDepositAddress([
      orderId2,
      depositor.account.address,
    ])

    expect(addr1).to.not.equal(addr2)
  })

  it("should return different addresses for different depositors", async function () {
    const { factory, depositor, anyone, orderId } = await loadFixture(
      deployDepositAddressFactory
    )

    const addr1 = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])
    const addr2 = await factory.read.computeDepositAddress([
      orderId,
      anyone.account.address,
    ])

    expect(addr1).to.not.equal(addr2)
  })

  it("should return a non-zero address", async function () {
    const { factory, orderId, depositor } = await loadFixture(
      deployDepositAddressFactory
    )

    const addr = await factory.read.computeDepositAddress([
      orderId,
      depositor.account.address,
    ])

    expect(addr).to.not.equal(zeroAddress)
  })
})
