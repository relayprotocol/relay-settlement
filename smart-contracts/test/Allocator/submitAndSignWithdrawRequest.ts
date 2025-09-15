import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { keccak256, toHex, zeroAddress } from 'viem'
import { deployAllocator } from '../helpers/deployAllocator'
import { extractEvent } from '../helpers/extractEvent'

const chainId = 1n

const gasSettings = {
  callbackGas: 5000000000000n,
  signGas: 20000000000000n,
}

describe('Allocator submitAndSignWithdrawRequest', function () {
  async function deployAllocatorWithSetup() {
    const { allocator, owner, otherAccounts, ...rest } = await deployAllocator()
    const [hub, depository] = otherAccounts

    const payloadBuilder = await hre.viem.deployContract('DummyPayloadBuilder')

    await allocator.write.setDelay([0], {
      account: owner.account,
    })

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
      depository,
      hub,
      owner,
      ...rest,
    }
  }

  it('should fail if no payload builder exists', async () => {
    const { allocator, hub, owner, depository } = await loadFixture(
      deployAllocatorWithSetup
    )

    await expect(
      allocator.write.submitAndSignWithdrawRequest(
        [
          {
            amount: 1n,
            chainId: 2n,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            nonce: keccak256('0xnonce'),
            receiver: owner.account.address,
            spender: owner.account.address,
          },
          '0x',
          gasSettings,
        ],
        {
          account: hub.account,
        }
      )
    ).to.be.rejectedWith(`NoPayloadBuilder(2, "${depository.account.address}")`)
  })

  it('should fail if there is a delay', async () => {
    const { allocator, hub, owner, depository, wNEAR } = await loadFixture(
      deployAllocatorWithSetup
    )

    await allocator.write.setDepositoryDelay([
      chainId,
      depository.account.address,
      1000,
    ])

    // approve sig fee
    const signatureFee = await allocator.read.signatureFee()
    await wNEAR.write.approve([allocator.address, signatureFee], {
      account: owner.account,
    })

    await expect(
      allocator.write.submitAndSignWithdrawRequest([
        {
          amount: 1n,
          chainId,
          currency: zeroAddress,
          data: '0x' as `0x${string}`,
          depository: depository.account.address,
          nonce: keccak256('0xnonce'),
          receiver: hub.account.address,
          spender: owner.account.address,
        },
        '0x',
        gasSettings,
      ])
    ).to.be.rejectedWith('PayloadNotReady')
    await allocator.write.setDepositoryDelay([
      chainId,
      depository.account.address,
      0,
    ])
  })

  describe('when successful', () => {
    async function deployAllocatorWithSetupForSuccess() {
      const { allocator, wNEAR, owner, ...rest } =
        await deployAllocatorWithSetup()

      await allocator.write.grantRole(
        [
          keccak256('APPROVED_WITHDRAWER_ROLE' as `0x${string}`),
          owner.account.address,
        ],
        {
          account: owner.account,
        }
      )

      // set approvals
      const wNearAmount = 9000000000000000000000000n
      await wNEAR.write.mint([wNearAmount], {
        account: owner.account,
      })
      await wNEAR.write.approve([allocator.address, 2n], {
        account: owner.account,
      })
      // approve from owner for init()
      await wNEAR.write.approve([allocator.address, wNearAmount])
      return {
        allocator,
        owner,
        wNEAR,
        ...rest,
      }
    }
    it('should emit an event with the payload hash', async () => {
      const { allocator, owner, depository, publicClient } = await loadFixture(
        deployAllocatorWithSetupForSuccess
      )

      const txHash = await allocator.write.submitAndSignWithdrawRequest(
        [
          {
            amount: 1n,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            nonce: keccak256('0xnonce'),
            receiver: owner.account.address,
            spender: owner.account.address,
          },
          '0x',
          gasSettings,
        ],
        {
          account: owner.account,
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
      expect(payloadBuiltEvent.args.withdrawRequestHash).to.not.equal(undefined)
      expect(payloadBuiltEvent.args.payload).to.equal(toHex('dummy payload'))
      expect(payloadBuiltEvent.args.timestamp).to.equal(
        block.timestamp + (initialIsSet ? initialDelay : defaultDelay)
      )
    })

    it('should store the unsigned payload', async () => {
      const { allocator, owner, depository, publicClient } = await loadFixture(
        deployAllocatorWithSetupForSuccess
      )

      const txHash = await allocator.write.submitAndSignWithdrawRequest(
        [
          {
            amount: 1n,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            nonce: keccak256('0xnonce'),
            receiver: owner.account.address,
            spender: owner.account.address,
          },
          '0x',
          gasSettings,
        ],
        {
          account: owner.account,
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
      const withdrawRequestHash = payloadBuiltEvent.args.withdrawRequestHash
      const unsignedPayload = await allocator.read.payloads([
        withdrawRequestHash,
      ])
      expect(unsignedPayload).to.equal(payloadBuiltEvent.args.payload)
    })
  })
})
