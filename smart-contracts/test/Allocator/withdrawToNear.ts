import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { decodeEventLog } from "viem"
import { deployAllocator } from "../helpers/deployAllocator"

describe("Allocator withdrawToNear", function () {
  async function deployAllocatorWithSetup() {
    const { allocator, owner, wNEAR, publicClient, otherAccounts } =
      await deployAllocator()

    // Mint wNEAR to allocator contract
    const amount = 1000000000000000000000n // 1000 tokens
    await wNEAR.write.transfer([allocator.address, amount], {
      account: owner.account,
    })

    return {
      allocator,
      amount,
      otherAccounts,
      owner,
      publicClient,
      wNEAR,
    }
  }

  it("should revert when called by non-owner", async () => {
    const { otherAccounts, amount, allocator } = await loadFixture(
      deployAllocatorWithSetup
    )
    const [nonOwner] = otherAccounts

    await expect(
      allocator.write.withdrawToNear([amount], { account: nonOwner.account })
    ).to.be.rejectedWith("OwnableUnauthorizedAccount")
  })

  it("should withdraw wNEAR to NEAR and emit WithdrawToNear event", async () => {
    const { owner, otherAccounts, amount, allocator, wNEAR, publicClient } =
      await loadFixture(deployAllocatorWithSetup)

    const [someone] = otherAccounts

    // fund allocator contract
    await wNEAR.write.transfer([allocator.address, amount], {
      account: owner.account,
    })

    const allocatorBalanceBefore = await wNEAR.read.balanceOf([
      allocator.address,
    ])
    const balanceBefore = await wNEAR.read.balanceOf([someone.account.address])

    // approve 1 yNEAR to process near tx
    await wNEAR.write.approve([allocator.address, 1n], {
      account: someone.account,
    })

    // send tx (only owner can call)
    const txHash = await allocator.write.withdrawToNear([amount], {
      account: owner.account,
    })
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })

    const allocatorBalanceAfter = await wNEAR.read.balanceOf([
      allocator.address,
    ])
    const balanceAfter = await wNEAR.read.balanceOf([someone.account.address])

    expect(balanceAfter).to.equal(balanceBefore)
    expect(allocatorBalanceBefore - amount).to.equal(allocatorBalanceAfter)

    // Check that transfer event was emitted by wNEAR
    const transferLog = receipt.logs.find(
      (log) => log.address === wNEAR.address
    )

    const transferEvent = decodeEventLog({
      abi: wNEAR.abi,
      data: transferLog.data,
      topics: transferLog.topics,
    })

    expect(transferEvent.args.value).to.equal(amount)
  })
})
