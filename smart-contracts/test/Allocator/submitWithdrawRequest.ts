import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import {
  decodeEventLog,
  keccak256,
  TransactionReceipt,
  zeroAddress,
} from 'viem'
import { DEFAULT_DELAY, deployAllocator } from '../helpers/deployAllocator'

const chainId = 1n

interface PayloadBuiltEvent {
  args: {
    payloadId: `0x${string}`
    payload: `0x${string}`
  }
}

const extractEvent = async (
  receipt: TransactionReceipt,
  eventName: string,
  abi: any
) => {
  const [event] = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({
          abi,
          data: log.data,
          eventName,
          topics: log.topics,
        })
      } catch {
        return null // or filter out unrecognized events
      }
    })
    .filter((e) => e !== null)
  return event as unknown as PayloadBuiltEvent
}

describe('Allocator submitWithdrawRequest', function () {
  async function deployAllocatorWithSetup() {
    const { allocator, owner, otherAccounts, publicClient } =
      await deployAllocator()
    const [hub, escrow, attacker] = otherAccounts

    const payloadBuilder = await hre.viem.deployContract('DummyPayloadBuilder')

    await allocator.write.setPayloadBuilder(
      [chainId, escrow.account.address, payloadBuilder.address],
      {
        account: owner.account,
      }
    )

    await allocator.write.grantRole(
      [keccak256('HUB_ROLE' as `0x${string}`), hub.account.address],
      {
        account: owner.account,
      }
    )

    return {
      allocator,
      attacker,
      escrow,
      hub,
      owner,
      publicClient,
    }
  }

  describe('submitWithdrawRequest()', function () {
    it('should fail if the request was not performed by a hub', async () => {
      const { allocator, attacker, escrow } = await loadFixture(
        deployAllocatorWithSetup
      )
      await expect(
        allocator.write.submitWithdrawRequest(
          [
            1n, //chainId
            escrow.account.address, // escrow
            zeroAddress, // currency
            1n, // amount
            attacker.account.address, // receiver
            '0x' as `0x${string}`, // data
          ],
          {
            account: attacker.account,
          }
        )
      ).to.be.rejectedWith(
        'CallerIsNotHub("0x90F79bf6EB2c4f870365E785982E1f101E93b906")'
      )
    })

    it('should fail if no payload builder exists', async () => {
      const { allocator, hub, escrow } = await loadFixture(
        deployAllocatorWithSetup
      )
      await expect(
        allocator.write.submitWithdrawRequest(
          [
            2n, // chainId
            escrow.account.address,
            zeroAddress, // currency
            1n, // amount
            hub.account.address, // receiver
            '0x' as `0x${string}`, // data
          ],
          {
            account: hub.account,
          }
        )
      ).to.be.rejectedWith(
        'NoPayloadBuilder(2, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")'
      )
    })

    it('should emit an event with the payload hash', async () => {
      const { allocator, hub, escrow, publicClient } = await loadFixture(
        deployAllocatorWithSetup
      )

      const txHash = await allocator.write.submitWithdrawRequest(
        [
          chainId,
          escrow.account.address,
          zeroAddress, // currency
          1n, // amount
          hub.account.address, // receiver
          '0x' as `0x${string}`, // data
        ],
        {
          account: hub.account,
        }
      )
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      const payloadBuiltEvent = await extractEvent(
        receipt,
        'PayloadBuilt',
        allocator.abi
      )
      expect(payloadBuiltEvent).to.not.equal(undefined)
    })

    it('should store the unsigned payload', async () => {
      const { allocator, hub, escrow, publicClient } = await loadFixture(
        deployAllocatorWithSetup
      )

      const txHash = await allocator.write.submitWithdrawRequest(
        [
          chainId,
          escrow.account.address,
          zeroAddress, // currency
          1n, // amount
          hub.account.address, // receiver
          '0x' as `0x${string}`, // data
        ],
        {
          account: hub.account,
        }
      )
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      const payloadBuiltEvent = await extractEvent(
        receipt,
        'PayloadBuilt',
        allocator.abi
      )
      const payloadId = payloadBuiltEvent.args.payloadId
      const payload = await allocator.read.unsignedPayloads([payloadId])
      expect(payload).to.equal(payloadBuiltEvent.args.payload)
    })
    it('should store the timestamp after which the payload can be signed', async () => {
      const { allocator, hub, escrow, publicClient } = await loadFixture(
        deployAllocatorWithSetup
      )

      const txHash = await allocator.write.submitWithdrawRequest(
        [
          chainId,
          escrow.account.address,
          zeroAddress, // currency
          1n, // amount
          hub.account.address, // receiver
          '0x' as `0x${string}`, // data
        ],
        {
          account: hub.account,
        }
      )
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      const payloadBuiltEvent = await extractEvent(
        receipt,
        'PayloadBuilt',
        allocator.abi
      )

      const payloadId = payloadBuiltEvent.args.payloadId
      const timestamp = await allocator.read.payloadTimestamps([payloadId])
      const block = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      })
      expect(timestamp).to.equal(block.timestamp + DEFAULT_DELAY)
    })
  })
})
