import {
  loadFixture,
  time,
} from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { decodeEventLog, getAddress, keccak256, zeroAddress } from 'viem'
import { deployAllocator } from '../helpers/deployAllocator'
import { deployHub } from '../helpers/deployHub'
import { generateAddress } from '@relay-protocol/hub-utils'
import { extractEvent } from '../helpers/extractEvent'

const chainId = 1n

const gasSettings = {
  callbackGas: 5000000000000n,
  signGas: 20000000000000n,
}

describe('Allocator signWithdrawPayload', function () {
  async function deployAllocatorWithSetup() {
    const { allocator, owner, otherAccounts, publicClient, wNEAR, utils } =
      await deployAllocator()
    const [depository, user, solver] = otherAccounts

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
          depository: depository.account.address,
          nonce: keccak256('0xnonce'),
          receiver: solver.account.address,
          spender: user.account.address,
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
      depository,
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

  describe('with an approved signer', () => {
    it('should successfully sign a payload with custom gas settings', async function () {
      const { allocator, solver, payloadId, publicClient, wNEAR } =
        await loadFixture(deployAllocatorWithSetup)

      // init transact
      await allocator.write.init()

      // wait for the delay
      await time.increase(await allocator.read.delay())

      const signHash = await allocator.write.signWithdrawPayload(
        [payloadId, '0x', gasSettings],
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
      const { allocator, solver, payloadId } = await loadFixture(
        deployAllocatorWithSetup
      )

      await expect(
        allocator.write.signWithdrawPayload([payloadId, '0x', gasSettings], {
          account: solver.account,
        })
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
      const [depository, user, solver] = otherAccounts

      const payloadBuilder = await hre.viem.deployContract(
        'DummyPayloadBuilder'
      )

      await allocator.write.setPayloadBuilder(
        [chainId, depository.account.address, payloadBuilder.address],
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

      // Set the Allocator as an operator for the user on the hub
      await hub.write.grantRole(
        [keccak256('OPERATOR_ROLE' as `0x${string}`), allocator.address],
        {
          account: owner.account,
        }
      )

      const family = await payloadBuilder.read.family()

      // Get the tokenId so we can later mint some tokens
      const tokenId = await utils.read.generateTokenId([
        family,
        chainId,
        zeroAddress,
      ])

      // Get the user address alias on the hub
      const userHubAddress = await utils.read.generateAddress([
        family,
        chainId,
        user.account.address,
      ])

      // and mint both for the alias and the EOA
      await hub.write.mint([userHubAddress, tokenId, 1n], {
        account: owner.account,
      })
      await hub.write.mint([user.account.address, tokenId, 2n], {
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
            depository: depository.account.address,
            nonce: keccak256('0xnonce'),
            receiver: user.account.address,
            spender: userHubAddress,
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
        publicClient,
        tokenId,
        userHubAddress,
        wNEAR,
      }
    }

    it('should work for an alias address and transfer its tokens to the allocator', async () => {
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
      const [user] = otherAccounts

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
        [payloadId, '0x', gasSettings],
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
      expect(allocatorBalanceAfter).to.be.equal(allocatorBalanceBefore + amount)
    })

    it('should fail if the caller is not an operator for the recipient', async () => {
      const { allocator, payloadId, otherAccounts } = await loadFixture(
        deployAllocatorAndSetHub
      )
      const [user] = otherAccounts

      await expect(
        allocator.write.signWithdrawPayload([payloadId, '0x', gasSettings], {
          account: user.account,
        })
      ).to.be.rejectedWith('CallerIsNotApproved')
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
      const [user] = otherAccounts

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
          account: owner.account,
        }
      )

      await expect(
        allocator.write.signWithdrawPayload([payloadId, '0x', gasSettings], {
          account: user.account,
        })
      ).to.be.rejected
    })

    it('should work for an EOA and transfer its tokens to the allocator', async () => {
      const {
        allocator,
        amount,
        otherAccounts,
        hub,
        wNEAR,
        tokenId,
        publicClient,
      } = await loadFixture(deployAllocatorAndSetHub)
      const [depository, user] = otherAccounts

      // Submit a new withdraw request
      const txHash = await allocator.write.submitWithdrawRequest(
        [
          {
            amount,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            nonce: keccak256('0xnonce'),
            receiver: user.account.address,
            spender: user.account.address,
          },
        ],
        {
          account: user.account,
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

      const userBalanceBefore = await hub.read.balanceOf([
        user.account.address,
        tokenId,
      ])
      expect(userBalanceBefore).to.be.equal(2n)
      const allocatorBalanceBefore = await hub.read.balanceOf([
        allocator.address,
        tokenId,
      ])
      expect(allocatorBalanceBefore).to.be.equal(0n)

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

      // wait for the delay
      await time.increase(await allocator.read.delay())

      await allocator.write.signWithdrawPayload(
        [payloadBuiltEvent.args.payloadId, '0x', gasSettings],
        {
          account: user.account,
        }
      )

      // Let's now check the balance of tokens for the Allocator
      const userBalanceAfter = await hub.read.balanceOf([
        user.account.address,
        tokenId,
      ])
      const allocatorBalanceAfter = await hub.read.balanceOf([
        allocator.address,
        tokenId,
      ])
      expect(userBalanceAfter).to.be.equal(userBalanceBefore - amount)
      expect(allocatorBalanceAfter).to.be.equal(allocatorBalanceBefore + amount)
    })

    describe('when using signatures to withdraw', () => {
      it('should fail if the spender is an alias of the receiver but no signature is provided', async () => {
        const { allocator, amount, otherAccounts, wNEAR, publicClient } =
          await loadFixture(deployAllocatorAndSetHub)
        const [depository, user] = otherAccounts

        const spender = generateAddress({
          address: user.account.address,
          chainId,
          family: 'dummy-vm',
        })

        // Submit a new withdraw request
        const txHash = await allocator.write.submitWithdrawRequest(
          [
            {
              amount,
              chainId,
              currency: zeroAddress,
              data: '0x' as `0x${string}`,
              depository: depository.account.address,
              nonce: keccak256('0xnonce'),
              receiver: user.account.address,
              spender,
            },
          ],
          {
            account: user.account,
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

        // wait for the delay
        await time.increase(await allocator.read.delay())

        await expect(
          allocator.write.signWithdrawPayload(
            [payloadBuiltEvent.args.payloadId, '0x', gasSettings],
            {
              account: user.account,
            }
          )
        ).to.be.rejectedWith('CallerIsNotApproved')
      })

      it('should fail if the spender is an alias of the receiver and the signature is for a different address', async () => {
        const { allocator, amount, otherAccounts, wNEAR, publicClient } =
          await loadFixture(deployAllocatorAndSetHub)
        const [depository, user, anotherUser] = otherAccounts

        const spender = generateAddress({
          address: user.account.address,
          chainId,
          family: 'dummy-vm',
        })

        // Submit a new withdraw request
        const txHash = await allocator.write.submitWithdrawRequest(
          [
            {
              amount,
              chainId,
              currency: zeroAddress,
              data: '0x' as `0x${string}`,
              depository: depository.account.address,
              nonce: keccak256('0xnonce'),
              receiver: user.account.address,
              spender,
            },
          ],
          {
            account: user.account,
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

        // wait for the delay
        await time.increase(await allocator.read.delay())

        // Use a unique nonce for this test
        const nonce = keccak256('0xnonce')

        const signature = await user.signTypedData({
          account: anotherUser.account,
          domain: {
            chainId: await publicClient.getChainId(),
            name: 'Allocator',
            verifyingContract: allocator.address,
            version: '1',
          },
          message: {
            amount,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            nonce,
            receiver: user.account.address,
            spender,
          },
          primaryType: 'SubmitWithdrawRequest',
          types: {
            SubmitWithdrawRequest: [
              { name: 'chainId', type: 'uint256' },
              { name: 'depository', type: 'string' },
              { name: 'currency', type: 'string' },
              { name: 'amount', type: 'uint256' },
              { name: 'spender', type: 'address' },
              { name: 'receiver', type: 'string' },
              { name: 'data', type: 'bytes' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
        })

        await expect(
          allocator.write.signWithdrawPayload(
            [payloadBuiltEvent.args.payloadId, signature, gasSettings],
            {
              account: user.account,
            }
          )
        ).to.be.rejectedWith('CallerIsNotApproved')
      })

      it('should work if the spender is an alias of the receiver and a valid signature for the receiver is provided', async () => {
        const {
          allocator,
          amount,
          otherAccounts,
          hub,
          wNEAR,
          tokenId,
          publicClient,
        } = await loadFixture(deployAllocatorAndSetHub)
        const [depository, user] = otherAccounts

        const spender = generateAddress({
          address: user.account.address,
          chainId,
          family: 'dummy-vm',
        })

        // Generate a unique nonce for this request
        const nonce = keccak256('0xnonce')

        // Submit a new withdraw request
        const txHash = await allocator.write.submitWithdrawRequest(
          [
            {
              amount,
              chainId,
              currency: zeroAddress,
              data: '0x' as `0x${string}`,
              depository: depository.account.address,
              nonce,
              receiver: user.account.address,
              spender,
            },
          ],
          {
            account: user.account,
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

        const spenderBalanceBefore = await hub.read.balanceOf([
          spender,
          tokenId,
        ])
        expect(spenderBalanceBefore).to.be.equal(1n)
        const allocatorBalanceBefore = await hub.read.balanceOf([
          allocator.address,
          tokenId,
        ])
        expect(allocatorBalanceBefore).to.be.equal(0n)

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

        // wait for the delay
        await time.increase(await allocator.read.delay())

        const signature = await user.signTypedData({
          account: user.account,
          domain: {
            chainId: await publicClient.getChainId(),
            name: 'Allocator',
            verifyingContract: allocator.address,
            version: '1',
          },
          message: {
            amount,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            nonce,
            receiver: user.account.address,
            spender,
          },
          primaryType: 'SubmitWithdrawRequest',
          types: {
            SubmitWithdrawRequest: [
              { name: 'chainId', type: 'uint256' },
              { name: 'depository', type: 'string' },
              { name: 'currency', type: 'string' },
              { name: 'amount', type: 'uint256' },
              { name: 'spender', type: 'address' },
              { name: 'receiver', type: 'string' },
              { name: 'data', type: 'bytes' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
        })

        await allocator.write.signWithdrawPayload(
          [payloadBuiltEvent.args.payloadId, signature, gasSettings],
          {
            account: user.account,
          }
        )

        // Let's now check the balance of tokens for the Allocator
        const spenderBalanceAfter = await hub.read.balanceOf([spender, tokenId])
        const allocatorBalanceAfter = await hub.read.balanceOf([
          allocator.address,
          tokenId,
        ])
        expect(spenderBalanceAfter).to.be.equal(spenderBalanceBefore - amount)
        expect(allocatorBalanceAfter).to.be.equal(
          allocatorBalanceBefore + amount
        )
      })

      it('should prevent replay attacks with same signature', async () => {
        const {
          allocator,
          amount,
          otherAccounts,
          hub,
          wNEAR,
          tokenId,
          publicClient,
        } = await loadFixture(deployAllocatorAndSetHub)
        const [depository, user] = otherAccounts

        const spender = generateAddress({
          address: user.account.address,
          chainId,
          family: 'dummy-vm',
        })

        // Mint more tokens so we can try the attack twice
        await hub.write.mint([spender, tokenId, 2n], {
          account: (await loadFixture(deployAllocatorAndSetHub)).owner.account,
        })

        // Generate unique nonces for the replay attack test
        const nonce1 = keccak256('replay_test_1')

        // Submit the first withdraw request
        const txHash1 = await allocator.write.submitWithdrawRequest(
          [
            {
              amount,
              chainId,
              currency: zeroAddress,
              data: '0x' as `0x${string}`,
              depository: depository.account.address,
              nonce: nonce1,
              receiver: user.account.address,
              spender,
            },
          ],
          {
            account: user.account,
          }
        )

        const receipt1 = await publicClient.waitForTransactionReceipt({
          hash: txHash1,
        })

        const payloadBuiltEvent1 = await extractEvent(
          receipt1,
          'PayloadBuilt',
          allocator.abi
        )

        // Use the same nonce as in the first transaction
        const nonce = nonce1

        const signature = await user.signTypedData({
          account: user.account,
          domain: {
            chainId: await publicClient.getChainId(),
            name: 'Allocator',
            verifyingContract: allocator.address,
            version: '1',
          },
          message: {
            amount,
            chainId,
            currency: zeroAddress,
            data: '0x' as `0x${string}`,
            depository: depository.account.address,
            nonce,
            receiver: user.account.address,
            spender,
          },
          primaryType: 'SubmitWithdrawRequest',
          types: {
            SubmitWithdrawRequest: [
              { name: 'chainId', type: 'uint256' },
              { name: 'depository', type: 'string' },
              { name: 'currency', type: 'string' },
              { name: 'amount', type: 'uint256' },
              { name: 'spender', type: 'address' },
              { name: 'receiver', type: 'string' },
              { name: 'data', type: 'bytes' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
        })

        // Set up wNEAR approvals
        const wNearAmount = 9000000000000000000000000n
        await wNEAR.write.mint([wNearAmount], {
          account: user.account,
        })
        await wNEAR.write.approve([allocator.address, 4n], {
          account: user.account,
        })

        // Wait for delay
        await time.increase(await allocator.read.delay())

        // First signature should work
        await allocator.write.signWithdrawPayload(
          [payloadBuiltEvent1.args.payloadId, signature, gasSettings],
          {
            account: user.account,
          }
        )

        // Now submit a second request with the same signature structure but incremented nonce
        const txHash2 = await allocator.write.submitWithdrawRequest(
          [
            {
              amount,
              chainId,
              currency: zeroAddress,
              data: '0x' as `0x${string}`,
              depository: depository.account.address,
              nonce: keccak256('0xnonce'),
              receiver: user.account.address,
              spender, // Same request structure
            },
          ],
          {
            account: user.account,
          }
        )

        const receipt2 = await publicClient.waitForTransactionReceipt({
          hash: txHash2,
        })

        const payloadBuiltEvent2 = await extractEvent(
          receipt2,
          'PayloadBuilt',
          allocator.abi
        )

        // Wait for delay
        await time.increase(await allocator.read.delay())

        // Trying to reuse the same signature should fail (nonce mismatch)
        await expect(
          allocator.write.signWithdrawPayload(
            [payloadBuiltEvent2.args.payloadId, signature, gasSettings],
            {
              account: user.account,
            }
          )
        ).to.be.rejectedWith('CallerIsNotApproved')
      })
    })
  })
})
