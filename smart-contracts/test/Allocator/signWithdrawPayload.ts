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
    const [escrow, user, solver] = otherAccounts

    const payloadBuilder = await hre.viem.deployContract('DummyPayloadBuilder')

    await allocator.write.setPayloadBuilder(
      [chainId, escrow.account.address, payloadBuilder.address],
      {
        account: owner.account,
      }
    )

    await allocator.write.grantRole(
      [
        keccak256('APPROVED_WITHDRAWER_ROLE' as `0x${string}`),
        solver.account.address,
      ],
      {
        account: owner.account,
      }
    )

    // set approvals
    const wNearAmount = 9000000000000000000000000n
    await wNEAR.write.mint([wNearAmount], {
      account: solver.account,
    })
    await wNEAR.write.approve([allocator.address, 2n], {
      account: solver.account,
    })
    // approve from owner for init()
    await wNEAR.write.approve([allocator.address, wNearAmount])

    const txHash = await allocator.write.submitWithdrawRequest(
      [
        {
          amount: 1n,
          chainId,
          currency: zeroAddress,
          data: '0x' as `0x${string}`,
          escrow: escrow.account.address,
          receiver: solver.account.address,
        },
      ],
      {
        account: solver.account,
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
      escrow,
      owner,
      payloadBuilder,
      payloadId: payloadBuiltEvent.args.payloadId,
      publicClient,
      solver,
      user,
      utils,
      wNEAR,
    }
  }

  describe('signWithdrawPayload()', function () {
    describe('with an approved signer', () => {
      it('should successfully sign a payload with custom gas settings', async function () {
        const { allocator, solver, escrow, payloadId, publicClient, wNEAR } =
          await loadFixture(deployAllocatorWithSetup)

        // init transact
        await allocator.write.init()

        // wait for the delay
        await time.increase(await allocator.read.delay())

        const signHash = await allocator.write.signWithdrawPayload(
          [chainId, escrow.account.address, payloadId, gasSettings],
          {
            account: solver.account,
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
        expect(transferArgs.from).to.equal(getAddress(solver.account.address))
        // can't test transferArgs.to as we dont have access to currentAccountId() from Aurora SDK
      })

      it('should revert when trying to sign a payload that is not ready', async function () {
        const { allocator, solver, escrow, payloadId } = await loadFixture(
          deployAllocatorWithSetup
        )

        await expect(
          allocator.write.signWithdrawPayload(
            [chainId, escrow.account.address, payloadId, gasSettings],
            {
              account: solver.account,
            }
          )
        ).to.be.rejectedWith('PayloadNotReady')
      })
    })

    describe('if the signer is not an approved signer', () => {
      async function deployAllocatorAndSetHub() {
        const {
          allocator,
          owner,
          otherAccounts,
          publicClient,
          wNEAR,
          utils,
          ...rest
        } = await deployAllocator()
        const [escrow, user, solver] = otherAccounts

        const payloadBuilder = await hre.viem.deployContract(
          'DummyPayloadBuilder'
        )

        await allocator.write.setPayloadBuilder(
          [chainId, escrow.account.address, payloadBuilder.address],
          {
            account: owner.account,
          }
        )

        // set wNEAR approvals
        const wNearAmount = 9000000000000000000000000n
        await wNEAR.write.mint([wNearAmount], {
          account: solver.account,
        })
        await wNEAR.write.approve([allocator.address, 2n], {
          account: solver.account,
        })
        // approve from owner for init()
        await wNEAR.write.approve([allocator.address, wNearAmount])

        // Let's deploy a Hub contract.
        const { hub } = await deployHub()

        // Set the hub on the allocator
        await allocator.write.setHub([hub.address], {
          account: owner.account,
        })
        // init transact
        await allocator.write.init()

        // Set the owner as operator so it can mint tokens
        await hub.write.grantRole(
          [keccak256('OPERATOR_ROLE' as `0x${string}`), owner.account.address],
          {
            account: owner.account,
          }
        )

        // Get the tokenId so we can later mint some tokens
        const tokenId = await utils.read.generateTokenId([
          'dummy-vm',
          chainId,
          zeroAddress,
        ])

        // Get the user address alias on the hub
        const userHubAddress = await utils.read.generateAddress([
          'dummy-vm',
          chainId,
          user.account.address,
        ])

        // and mint!
        await hub.write.mint([userHubAddress, tokenId, 1n], {
          account: owner.account,
        })

        const amount = 1n

        // Submit the withdraw request
        const txHash = await allocator.write.submitWithdrawRequest(
          [
            {
              amount,
              chainId,
              currency: zeroAddress,
              data: '0x' as `0x${string}`,
              escrow: escrow.account.address,
              receiver: user.account.address,
            },
          ],
          {
            account: solver.account,
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

        // wait for the delay
        await time.increase(await allocator.read.delay())
        return {
          ...rest,
          allocator,
          amount,
          hub,
          otherAccounts,
          owner,
          payloadId: payloadBuiltEvent.args.payloadId,
          tokenId,
          userHubAddress,
          wNEAR,
        }
      }

      it('should first transfer the tokens of the recipient to the Allocator contract', async () => {
        const {
          allocator,
          amount,
          payloadId,
          otherAccounts,
          owner,
          hub,
          userHubAddress,
          wNEAR,
          tokenId,
        } = await loadFixture(deployAllocatorAndSetHub)
        const [escrow, user] = otherAccounts

        const userBalanceBefore = await hub.read.balanceOf([
          userHubAddress,
          tokenId,
        ])
        expect(userBalanceBefore).to.be.equal(1n)
        const allocatorBalanceBefore = await hub.read.balanceOf([
          allocator.address,
          tokenId,
        ])
        expect(allocatorBalanceBefore).to.be.equal(0n)

        // Use the operator to set our EOA as an operator for the user on the hub
        await hub.write.setOperatorFor(
          [userHubAddress, user.account.address, true],
          {
            account: owner.account,
          }
        )

        // Use the operator to set the Allocator as an operator for the user on the hub
        await hub.write.setOperatorFor(
          [userHubAddress, allocator.address, true],
          {
            account: owner.account,
          }
        )

        // set wNEAR approvals
        const wNearAmount = 9000000000000000000000000n
        await wNEAR.write.mint([wNearAmount], {
          account: user.account,
        })
        await wNEAR.write.approve([allocator.address, 2n], {
          account: user.account,
        })
        // approve from owner for init()
        await wNEAR.write.approve([allocator.address, wNearAmount], {
          account: user.account,
        })

        await allocator.write.signWithdrawPayload(
          [chainId, escrow.account.address, payloadId, gasSettings],
          {
            account: user.account,
          }
        )

        // Let's now check the balance of tokens for the Allocator
        const userBalanceAfter = await hub.read.balanceOf([
          userHubAddress,
          tokenId,
        ])
        const allocatorBalanceAfter = await hub.read.balanceOf([
          allocator.address,
          tokenId,
        ])
        expect(userBalanceAfter).to.be.equal(userBalanceBefore - amount)
        expect(allocatorBalanceAfter).to.be.equal(
          allocatorBalanceBefore + amount
        )
      })

      it('should fail if the caller is not an operator for the recipient', async () => {
        const { allocator, payloadId, otherAccounts } = await loadFixture(
          deployAllocatorAndSetHub
        )
        const [escrow, user] = otherAccounts

        await expect(
          allocator.write.signWithdrawPayload(
            [chainId, escrow.account.address, payloadId, gasSettings],
            {
              account: user.account,
            }
          )
        ).to.be.rejectedWith('CallerIsNotApproved')
      })

      it('should fail if the Allocator is not an operator for the recipient', async () => {
        const {
          allocator,
          payloadId,
          otherAccounts,
          owner,
          hub,
          userHubAddress,
        } = await loadFixture(deployAllocatorAndSetHub)
        const [escrow, user] = otherAccounts

        // Use the operator to set our EOA as an operator for the user on the hub
        await hub.write.setOperatorFor(
          [userHubAddress, user.account.address, true],
          {
            account: owner.account,
          }
        )

        // Use the operator to set the Allocator as an operator for the user on the hub
        await hub.write.setOperatorFor(
          [userHubAddress, allocator.address, true],
          {
            account: owner.account,
          }
        )

        await expect(
          allocator.write.signWithdrawPayload(
            [chainId, escrow.account.address, payloadId, gasSettings],
            {
              account: user.account,
            }
          )
        ).to.be.rejectedWith('ERC20InsufficientAllowance')
      })

      it('should fail if the tokens from the allocator contract could not be transfered', async () => {
        const {
          allocator,
          amount,
          payloadId,
          otherAccounts,
          owner,
          hub,
          userHubAddress,
          tokenId,
        } = await loadFixture(deployAllocatorAndSetHub)
        const [escrow, user] = otherAccounts

        // Use the operator to set our EOA as an operator for the user on the hub
        await hub.write.setOperatorFor(
          [userHubAddress, user.account.address, true],
          {
            account: owner.account,
          }
        )

        // Use the operator to set the Allocator as an operator for the user on the hub
        await hub.write.setOperatorFor(
          [userHubAddress, allocator.address, true],
          {
            account: owner.account,
          }
        )

        // Transfer the tokens away before trying to sign!
        await hub.write.transferFrom(
          [userHubAddress, zeroAddress, tokenId, amount],
          {
            account: user.account,
          }
        )

        await expect(
          allocator.write.signWithdrawPayload(
            [chainId, escrow.account.address, payloadId, gasSettings],
            {
              account: user.account,
            }
          )
        ).to.be.rejected
      })
    })
  })
})
