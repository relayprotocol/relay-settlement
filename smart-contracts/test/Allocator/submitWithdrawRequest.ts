import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import AllocatorModule from '../../ignition/modules/Allocator'
import {
  decodeEventLog,
  keccak256,
  TransactionReceipt,
  zeroAddress,
} from 'viem'

const DEFAULT_DELAY = 600n
const chainId = 1n

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
  return event
}

describe('Allocator submitWithdrawRequest', function () {
  async function deployAllocator() {
    const [owner, solver, escrow, attacker] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    const { allocator } = await hre.ignition.deploy(AllocatorModule, {
      parameters: {
        Allocator: {
          delay: DEFAULT_DELAY,
          owner: owner.account.address,
        },
      },
    })

    const payloadBuilder = await hre.viem.deployContract('DummyPayloadBuilder')

    await allocator.write.setPayloadBuilder({
      account: owner.account,
      args: [chainId, escrow.account.address, payloadBuilder.address],
    })

    await allocator.write.grantRole({
      account: owner.account,
      args: [keccak256('SOLVER_ROLE'), solver.account.address],
    })

    return {
      allocator,
      attacker,
      escrow,
      owner,
      publicClient,
      solver,
    }
  }

  describe('submitWithdrawRequest()', function () {
    it('should fail if the request was not performed by a solver', async () => {
      const { allocator, attacker, escrow } = await loadFixture(deployAllocator)
      await expect(
        allocator.write.submitWithdrawRequest({
          account: attacker.account,
          args: [
            1n, //chainId
            escrow.account.address, // escrow
            zeroAddress, // currency
            1n, // amount
            attacker.account.address, // receiver
            '', // data
          ],
        })
      ).to.be.rejectedWith(
        'CallerIsNotSolver("0x90F79bf6EB2c4f870365E785982E1f101E93b906")'
      )
    })

    it('should fail if no payload builder exists', async () => {
      const { allocator, solver, escrow } = await loadFixture(deployAllocator)
      await expect(
        allocator.write.submitWithdrawRequest({
          account: solver.account,
          args: [
            2n, // chainId
            escrow.account.address,
            zeroAddress, // currency
            1n, // amount
            solver.account.address, // receiver
            '', // data
          ],
        })
      ).to.be.rejectedWith(
        'NoPayloadBuilder(2, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")'
      )
    })

    it('should emit an event with the payload hash', async () => {
      const { allocator, solver, escrow, publicClient } =
        await loadFixture(deployAllocator)

      const txHash = await allocator.write.submitWithdrawRequest({
        account: solver.account,
        args: [
          chainId,
          escrow.account.address,
          zeroAddress, // currency
          1n, // amount
          solver.account.address, // receiver
          '', // data
        ],
      })
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
      const { allocator, solver, escrow, publicClient } =
        await loadFixture(deployAllocator)

      const txHash = await allocator.write.submitWithdrawRequest({
        account: solver.account,
        args: [
          chainId,
          escrow.account.address,
          zeroAddress, // currency
          1n, // amount
          solver.account.address, // receiver
          '', // data
        ],
      })
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      const payloadBuiltEvent = await extractEvent(
        receipt,
        'PayloadBuilt',
        allocator.abi
      )
      const payloadHash = payloadBuiltEvent.args.payloadHash
      const payload = await allocator.read.unsignedPayloads([payloadHash])
      expect(payload).to.equal(payloadBuiltEvent.args.payload)
    })
    it('should store the timestamp after which the payload can be signed', async () => {
      const { allocator, solver, escrow, publicClient } =
        await loadFixture(deployAllocator)

      const txHash = await allocator.write.submitWithdrawRequest({
        account: solver.account,
        args: [
          chainId,
          escrow.account.address,
          zeroAddress, // currency
          1n, // amount
          solver.account.address, // receiver
          '', // data
        ],
      })
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      const payloadBuiltEvent = await extractEvent(
        receipt,
        'PayloadBuilt',
        allocator.abi
      )

      const payloadHash = payloadBuiltEvent.args.payloadHash
      const timestamp = await allocator.read.payloadTimestamps([payloadHash])
      const block = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      })
      expect(timestamp).to.equal(block.timestamp + DEFAULT_DELAY)
    })
  })
})
