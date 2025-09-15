import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import { decodeEventLog } from 'viem'
import { deployAllocator } from '../helpers/deployAllocator'

describe('Allocator withdrawToNear', function () {
  async function deployAllocatorWithSetup() {
    const { allocator, owner, wNEAR, publicClient } = await deployAllocator()

    // Mint wNEAR to allocator contract
    const amount = 1000000000000000000000n // 1000 tokens
    await wNEAR.write.transfer([allocator.address, amount], {
      account: owner.account,
    })

    return {
      allocator,
      amount,
      owner,
      publicClient,
      wNEAR,
    }
  }

  it('should withdraw wNEAR to NEAR and emit WithdrawToNear event', async () => {
    const { allocator, wNEAR, publicClient, amount } = await loadFixture(
      deployAllocatorWithSetup
    )

    const txHash = await allocator.write.withdrawToNear([amount])
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })

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
