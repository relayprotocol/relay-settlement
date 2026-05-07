import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { toHex, zeroAddress } from "viem"

const CHAIN_ID = "ethereum-mainnet"
const SPENDER_CHAIN_ID = "ethereum-mainnet"
const EXPIRATION_DELAY_SECONDS = 10n * 24n * 60n * 60n

const WITHDRAW_REQUEST_TYPES = {
  WithdrawRequest: [
    { name: "chainId", type: "string" },
    { name: "depository", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "amount", type: "uint256" },
    { name: "spenderChainId", type: "string" },
    { name: "spender", type: "bytes" },
    { name: "receiver", type: "bytes" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "bytes32" },
  ],
} as const

async function deployRelayAllocatorFixture() {
  const [owner, relayer, receiver, depository] =
    await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()

  const utils = await hre.viem.deployContract("Utils", [])
  const hub = await hre.viem.deployContract("RelayHub", [owner.account.address])
  const allocator = await hre.viem.deployContract(
    "RelayAllocator",
    [owner.account.address, hub.address],
    {
      libraries: {
        Utils: utils.address,
      },
    }
  )
  const config = await hre.viem.deployContract("Config", [allocator.address])
  const payloadBuilder = await hre.viem.deployContract(
    "EthereumVmPayloadBuilder",
    [config.address]
  )
  await allocator.write.setPayloadBuilder(
    [CHAIN_ID, depository.account.address, payloadBuilder.address],
    { account: owner.account }
  )

  const expirationKey = await payloadBuilder.read.getExpirationKey()
  const evmChainIdKey = await payloadBuilder.read.getEvmChainIdKey([CHAIN_ID])
  await config.write.setConfigValues(
    [
      [expirationKey, evmChainIdKey],
      [toHex(EXPIRATION_DELAY_SECONDS, { size: 32 }), toHex(1n, { size: 32 })],
    ],
    { account: owner.account }
  )

  const operatorRole = await hub.read.OPERATOR_ROLE()
  await hub.write.grantRole([operatorRole, owner.account.address], {
    account: owner.account,
  })
  await hub.write.grantRole([operatorRole, allocator.address], {
    account: owner.account,
  })

  const spenderAlias = await utils.read.generateAddress([
    SPENDER_CHAIN_ID,
    receiver.account.address,
  ])
  const tokenId = await utils.read.generateTokenId([CHAIN_ID, zeroAddress])
  await hub.write.mint([spenderAlias, tokenId, 100n], {
    account: owner.account,
  })

  return {
    allocator,
    depository,
    hub,
    owner,
    publicClient,
    receiver,
    relayer,
    spenderAlias,
    tokenId,
  }
}

describe("RelayAllocator", function () {
  describe("suspend()/unsuspend()", function () {
    it("only allows the owner to suspend a spender alias", async function () {
      const { allocator, relayer, spenderAlias } = await loadFixture(
        deployRelayAllocatorFixture
      )

      await expect(
        allocator.write.suspend([spenderAlias], {
          account: relayer.account,
        })
      ).to.be.rejected
    })

    it("blocks withdrawals for a suspended spender alias", async function () {
      const { allocator, depository, owner, receiver, spenderAlias } =
        await loadFixture(deployRelayAllocatorFixture)

      await allocator.write.suspend([spenderAlias], {
        account: owner.account,
      })

      await expect(
        allocator.write.submitWithdrawRequest(
          [
            {
              amount: 10n,
              chainId: CHAIN_ID,
              currency: zeroAddress,
              data: "0x",
              depository: depository.account.address,
              nonce: toHex(1n, { size: 32 }),
              receiver: receiver.account.address,
              spender: receiver.account.address,
              spenderChainId: SPENDER_CHAIN_ID,
            },
          ],
          { account: receiver.account }
        )
      ).to.be.rejectedWith("SpenderSuspended")
    })

    it("allows the owner to unsuspend a spender alias", async function () {
      const { allocator, depository, owner, receiver, spenderAlias } =
        await loadFixture(deployRelayAllocatorFixture)

      await allocator.write.suspend([spenderAlias], {
        account: owner.account,
      })
      await allocator.write.unsuspend([spenderAlias], {
        account: owner.account,
      })

      await expect(
        allocator.write.submitWithdrawRequest(
          [
            {
              amount: 10n,
              chainId: CHAIN_ID,
              currency: zeroAddress,
              data: "0x",
              depository: depository.account.address,
              nonce: toHex(1n, { size: 32 }),
              receiver: receiver.account.address,
              spender: receiver.account.address,
              spenderChainId: SPENDER_CHAIN_ID,
            },
          ],
          { account: receiver.account }
        )
      ).to.not.be.rejected
    })
  })

  describe("submitWithdrawRequest()", function () {
    it("reverts when the payload builder returns an empty payload", async function () {
      const { allocator, depository, owner, receiver } = await loadFixture(
        deployRelayAllocatorFixture
      )
      const emptyPayloadBuilder = await hre.viem.deployContract(
        "EmptyPayloadBuilder",
        []
      )

      await allocator.write.setPayloadBuilder(
        [CHAIN_ID, depository.account.address, emptyPayloadBuilder.address],
        { account: owner.account }
      )

      await expect(
        allocator.write.submitWithdrawRequest(
          [
            {
              amount: 10n,
              chainId: CHAIN_ID,
              currency: zeroAddress,
              data: "0x",
              depository: depository.account.address,
              nonce: toHex(1n, { size: 32 }),
              receiver: receiver.account.address,
              spender: receiver.account.address,
              spenderChainId: SPENDER_CHAIN_ID,
            },
          ],
          { account: receiver.account }
        )
      ).to.be.rejectedWith("EmptyPayload")
    })

    it("checks duplicate requests before building a replacement payload", async function () {
      const { allocator, depository, owner, publicClient, receiver } =
        await loadFixture(deployRelayAllocatorFixture)
      const request = {
        amount: 10n,
        chainId: CHAIN_ID,
        currency: zeroAddress,
        data: "0x",
        depository: depository.account.address,
        nonce: toHex(1n, { size: 32 }),
        receiver: receiver.account.address,
        spender: receiver.account.address,
        spenderChainId: SPENDER_CHAIN_ID,
      } as const

      const txHash = await allocator.write.submitWithdrawRequest([request], {
        account: receiver.account,
      })
      await publicClient.waitForTransactionReceipt({ hash: txHash })

      const emptyPayloadBuilder = await hre.viem.deployContract(
        "EmptyPayloadBuilder",
        []
      )
      await allocator.write.setPayloadBuilder(
        [CHAIN_ID, depository.account.address, emptyPayloadBuilder.address],
        { account: owner.account }
      )

      await expect(
        allocator.write.submitWithdrawRequest([request], {
          account: receiver.account,
        })
      ).to.be.rejectedWith("WithdrawRequestAlreadyProcessed")
    })

    it("allows direct withdrawals from a 20-byte spender without a signature", async function () {
      const {
        allocator,
        depository,
        hub,
        publicClient,
        receiver,
        spenderAlias,
        tokenId,
      } = await loadFixture(deployRelayAllocatorFixture)

      const txHash = await allocator.write.submitWithdrawRequest(
        [
          {
            amount: 10n,
            chainId: CHAIN_ID,
            currency: zeroAddress,
            data: "0x",
            depository: depository.account.address,
            nonce: toHex(1n, { size: 32 }),
            receiver: receiver.account.address,
            spender: receiver.account.address,
            spenderChainId: SPENDER_CHAIN_ID,
          },
        ],
        { account: receiver.account }
      )
      await publicClient.waitForTransactionReceipt({ hash: txHash })

      expect(await hub.read.balanceOf([spenderAlias, tokenId])).to.equal(90n)
    })
  })

  describe("submitWithdrawRequestWithSignature()", function () {
    it("rejects alias-based withdrawals without a receiver signature", async function () {
      const { allocator, depository, relayer, receiver } = await loadFixture(
        deployRelayAllocatorFixture
      )

      await expect(
        allocator.write.submitWithdrawRequest(
          [
            {
              amount: 10n,
              chainId: CHAIN_ID,
              currency: zeroAddress,
              data: "0x",
              depository: depository.account.address,
              nonce: toHex(1n, { size: 32 }),
              receiver: receiver.account.address,
              spender: receiver.account.address,
              spenderChainId: SPENDER_CHAIN_ID,
            },
          ],
          { account: relayer.account }
        )
      ).to.be.rejectedWith("CallerIsNotApproved")
    })

    it("allows alias-based withdrawals with a valid receiver signature", async function () {
      const {
        allocator,
        depository,
        hub,
        publicClient,
        receiver,
        relayer,
        spenderAlias,
        tokenId,
      } = await loadFixture(deployRelayAllocatorFixture)

      const request = {
        amount: 10n,
        chainId: CHAIN_ID,
        currency: zeroAddress,
        data: "0x",
        depository: depository.account.address,
        nonce: toHex(1n, { size: 32 }),
        receiver: receiver.account.address,
        spender: receiver.account.address,
        spenderChainId: SPENDER_CHAIN_ID,
      } as const

      const signature = await receiver.signTypedData({
        domain: {
          chainId: await publicClient.getChainId(),
          name: "RelayAllocator",
          verifyingContract: allocator.address,
          version: "1",
        },
        message: request,
        primaryType: "WithdrawRequest",
        types: WITHDRAW_REQUEST_TYPES,
      })

      const txHash = await allocator.write.submitWithdrawRequestWithSignature(
        [request, signature],
        { account: relayer.account }
      )
      await publicClient.waitForTransactionReceipt({ hash: txHash })

      expect(await hub.read.balanceOf([spenderAlias, tokenId])).to.equal(90n)
      expect(
        await allocator.read.usedNonces([
          receiver.account.address,
          toHex(1n, { size: 32 }),
        ])
      ).to.equal(true)
    })

    it("rejects replaying a receiver nonce", async function () {
      const { allocator, depository, publicClient, receiver, relayer } =
        await loadFixture(deployRelayAllocatorFixture)

      const nonce = toHex(1n, { size: 32 })
      const request = {
        amount: 10n,
        chainId: CHAIN_ID,
        currency: zeroAddress,
        data: "0x",
        depository: depository.account.address,
        nonce,
        receiver: receiver.account.address,
        spender: receiver.account.address,
        spenderChainId: SPENDER_CHAIN_ID,
      } as const

      const signature = await receiver.signTypedData({
        domain: {
          chainId: await publicClient.getChainId(),
          name: "RelayAllocator",
          verifyingContract: allocator.address,
          version: "1",
        },
        message: request,
        primaryType: "WithdrawRequest",
        types: WITHDRAW_REQUEST_TYPES,
      })

      await allocator.write.submitWithdrawRequestWithSignature(
        [request, signature],
        {
          account: relayer.account,
        }
      )

      await expect(
        allocator.write.submitWithdrawRequestWithSignature(
          [
            {
              ...request,
              amount: 11n,
            },
            signature,
          ],
          { account: relayer.account }
        )
      ).to.be.rejectedWith("CallerIsNotApproved")
    })
  })
})
