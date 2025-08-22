import {
  loadFixture,
  time,
} from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import {
  decodeEventLog,
  getAddress,
  keccak256,
  TransactionReceipt,
  zeroAddress,
} from 'viem'
import { deployAllocator } from '../helpers/deployAllocator'
import { deployHub } from '../helpers/deployHub'

const chainId = 1n

const gasSettings = {
  callbackGas: 5000000000000n,
  signGas: 20000000000000n,
}

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
        return null
      }
    })
    .filter((e) => e !== null)
  return event as unknown as PayloadBuiltEvent
}

describe('Allocator signWithdrawPayload', function () {
  async function deployAllocatorWithSetup() {
    const { allocator, owner, otherAccounts, publicClient, wNEAR, utils } =
      await deployAllocator()
    // We have a `hubContract` and `hub` in order to simplify calls to the allocator
    // (it is much easier to call from an EOA vs impersonate a contract and execute
    // a call on behalf of it).
    const { hub: hubContract } = await deployHub()
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

    // We need the owner to be able to mint for testing purposes
    await hubContract.write.grantRole(
      [keccak256('HUB_ORACLE_ROLE' as `0x${string}`), owner.account.address],
      {
        account: owner.account,
      }
    )

    // The allocator needs to be able to burn tokens on the hub
    await hubContract.write.grantRole(
      [keccak256('HUB_ORACLE_ROLE' as `0x${string}`), allocator.address],
      {
        account: owner.account,
      }
    )

    // Mint tokens on the hub
    const tokenId = await utils.read.generateTokenId([
      'dummy',
      chainId,
      zeroAddress,
    ])
    await hubContract.write.mint([hub.account.address, tokenId, 1n], {
      account: owner.account,
    })

    // set approvals
    const amount = 9000000000000000000000000n
    await wNEAR.write.mint([amount], {
      account: hub.account,
    })
    await wNEAR.write.approve([allocator.address, 2n], {
      account: hub.account,
    })
    // approve from owner for init()
    await wNEAR.write.approve([allocator.address, amount])

    const txHash = await allocator.write.submitWithdrawRequest(
      [
        {
          amount: 1n,
          chainId,
          currency: zeroAddress,
          data: '0x' as `0x${string}`,
          escrow: escrow.account.address,
          hub: hubContract.address,
          receiver: hub.account.address,
          sender: hub.account.address,
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

    return {
      allocator,
      attacker,
      escrow,
      hub,
      hubContract,
      owner,
      payloadBuilder,
      payloadId: payloadBuiltEvent.args.payloadId,
      publicClient,
      wNEAR,
    }
  }

  describe('signWithdrawPayload()', function () {
    it('should successfully sign a payload with custom gas settings', async function () {
      const { allocator, hub, escrow, payloadId, publicClient, wNEAR } =
        await loadFixture(deployAllocatorWithSetup)

      // init transact
      await allocator.write.init()

      // wait for the delay
      await time.increase(await allocator.read.delay())

      console.log()
      const signHash = await allocator.write.signWithdrawPayload(
        [chainId, escrow.account.address, payloadId, gasSettings],
        {
          account: hub.account,
        }
      )

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: signHash,
      })

      // some wNEAR should have been transferred to the executor
      const transferLog = receipt.logs.find(
        (event) => event.address === wNEAR.address
      )
      const { args: transferArgs } = decodeEventLog({
        abi: wNEAR.abi,
        data: transferLog!.data,
        topics: transferLog!.topics,
      })
      expect(transferArgs!.value).to.equal(1n)
      expect(transferArgs.from).to.equal(getAddress(hub.account.address))
      // can't test transferArgs.to as we dont have access to currentAccountId() from Aurora SDK
    })

    it('should revert when trying to sign a payload that is not ready', async function () {
      const { allocator, hub, escrow, payloadId } = await loadFixture(
        deployAllocatorWithSetup
      )

      await expect(
        allocator.write.signWithdrawPayload(
          [chainId, escrow.account.address, payloadId, gasSettings],
          {
            account: hub.account,
          }
        )
      ).to.be.rejectedWith('PayloadNotReady')
    })

    it('should revert when contract is disabled', async function () {
      const { allocator, hub, escrow, payloadId } = await loadFixture(
        deployAllocatorWithSetup
      )

      // wait for payload to be ready
      await time.increase(await allocator.read.delay())

      // init xcc sub account
      // await allocator.write.init()

      await expect(
        allocator.write.signWithdrawPayload(
          [chainId, escrow.account.address, payloadId, gasSettings],
          {
            account: hub.account,
          }
        )
      ).to.be.rejectedWith('WithdrawalDisabled')
    })
  })
})
