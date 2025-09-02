import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import {
  decodeEventLog,
  keccak256,
  toHex,
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
    const [hub, depository, attacker] = otherAccounts

    const payloadBuilder = await hre.viem.deployContract('DummyPayloadBuilder')

    await allocator.write.setPayloadBuilder(
      [chainId, depository.account.address, payloadBuilder.address],
      {
        account: owner.account,
      }
    )

    await allocator.write.grantRole(
      [
        keccak256('APPROVED_WITHDRAWER_ROLE' as `0x${string}`),
        hub.account.address,
      ],
      {
        account: owner.account,
      }
    )

    return {
      allocator,
      attacker,
      depository,
      hub,
      owner,
      publicClient,
    }
  }

  describe('submitWithdrawRequest()', function () {
    it('should fail if no payload builder exists', async () => {
      const { allocator, hub, owner, depository } = await loadFixture(
        deployAllocatorWithSetup
      )

      await expect(
        allocator.write.submitWithdrawRequest(
          [
            {
              amount: 1n,
              chainId: 2n,
              currency: zeroAddress,
              data: '0x' as `0x${string}`,
              depository: depository.account.address,
              receiver: owner.account.address,
              spender: owner.account.address,
            },
          ],
          {
            account: hub.account,
          }
        )
      ).to.be.rejectedWith(
        `NoPayloadBuilder(2, "${depository.account.address}")`
      )
    })

    it('should emit an event with the payload hash', async () => {
      const { allocator, hub, owner, depository, publicClient } =
        await loadFixture(deployAllocatorWithSetup)

      const txHash = await allocator.write.submitWithdrawRequest(
        [
          {
            amount: 1n,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            receiver: hub.account.address,
            spender: owner.account.address,
          },
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
      const [block, defaultDelay, [initialDelay, initialIsSet]] =
        await Promise.all([
          publicClient.getBlock(),
          allocator.read.delay(),
          allocator.read.depositoryDelays([chainId, depository]),
        ])
      expect(payloadBuiltEvent).to.not.equal(undefined)
      expect(payloadBuiltEvent.args.payloadId).to.not.equal(undefined)
      expect(payloadBuiltEvent.args.payload).to.equal(toHex('dummy payload'))
      expect(payloadBuiltEvent.args.timestamp).to.equal(
        block.timestamp + (initialIsSet ? initialDelay : defaultDelay)
      )
    })

    it('should store the unsigned payload', async () => {
      const { allocator, hub, depository, publicClient } = await loadFixture(
        deployAllocatorWithSetup
      )

      const txHash = await allocator.write.submitWithdrawRequest(
        [
          {
            amount: 1n,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            receiver: hub.account.address,
            spender: hub.account.address,
          },
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
      const [, unsignedPayload] = await allocator.read.payloads([payloadId])
      expect(unsignedPayload).to.equal(payloadBuiltEvent.args.payload)
    })

    it('should store the timestamp after which the payload can be signed', async () => {
      const { allocator, hub, depository, publicClient } = await loadFixture(
        deployAllocatorWithSetup
      )

      const txHash = await allocator.write.submitWithdrawRequest(
        [
          {
            amount: 1n,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            receiver: hub.account.address,
            spender: hub.account.address,
          },
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
