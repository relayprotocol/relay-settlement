import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import { deployAllocatorSpender } from "../helpers/deployAllocatorSpender"

const gasSettings = {
  callbackGas: 5000000000000n,
  signGas: 20000000000000n,
}

async function signWithdrawRequest(
  params: {
    chainId: bigint
    depository: string
    currency: string
    amount: bigint
    spender: string
    receiver: string
    data: `0x${string}`
    nonce: `0x${string}`
  },
  spenderAddress: string,
  oracleWallet: any
) {
  return oracleWallet.signTypedData({
    domain: {
      chainId: await oracleWallet.getChainId(),
      name: "RelayAllocatorSpender",
      verifyingContract: spenderAddress,
      version: "1",
    },
    message: params,
    primaryType: "SubmitWithdrawRequest",
    types: {
      SubmitWithdrawRequest: [
        { name: "chainId", type: "uint256" },
        { name: "depository", type: "string" },
        { name: "currency", type: "string" },
        { name: "amount", type: "uint256" },
        { name: "spender", type: "address" },
        { name: "receiver", type: "string" },
        { name: "data", type: "bytes" },
        { name: "nonce", type: "bytes32" },
      ],
    },
  })
}

describe("RelayAllocatorSpender signWithdrawPayloadHash", function () {
  it("should call allocator.signWithdrawPayloadHash with a valid oracle signature", async function () {
    const {
      allocator,
      caller,
      oracleWallet,
      publicClient,
      requestParams,
      spender,
    } = await loadFixture(deployAllocatorSpender)

    // Initialize allocator (required for NEAR XCC)
    await allocator.write.init()

    // Wait for delay
    await time.increase(await allocator.read.delay())

    // Oracle signs the request
    const oracleSignature = await signWithdrawRequest(
      requestParams,
      spender.address,
      oracleWallet
    )

    // Anyone can call as long as oracle signature is valid
    const txHash = await spender.write.signWithdrawPayloadHash(
      [
        requestParams,
        gasSettings,
        0,
        oracleWallet.account.address,
        oracleSignature,
      ],
      { account: caller.account }
    )

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })
    expect(receipt.status).to.equal("success")
  })

  it("should revert with UnauthorizedOracle when oracle lacks ORACLE_ROLE", async function () {
    const { allocator, caller, remainingAccounts, requestParams, spender } =
      await loadFixture(deployAllocatorSpender)

    await allocator.write.init()
    await time.increase(await allocator.read.delay())

    const unauthorizedOracle = remainingAccounts[0]

    const signature = await signWithdrawRequest(
      requestParams,
      spender.address,
      unauthorizedOracle
    )

    await expect(
      spender.write.signWithdrawPayloadHash(
        [
          requestParams,
          gasSettings,
          0,
          unauthorizedOracle.account.address,
          signature,
        ],
        { account: caller.account }
      )
    ).to.be.rejectedWith("UnauthorizedOracle")
  })

  it("should revert with InvalidOracleSignature when signature does not match oracle", async function () {
    const {
      allocator,
      caller,
      oracleWallet,
      remainingAccounts,
      requestParams,
      spender,
    } = await loadFixture(deployAllocatorSpender)

    await allocator.write.init()
    await time.increase(await allocator.read.delay())

    // Sign with a different wallet but claim it's from the oracle
    const wrongSigner = remainingAccounts[0]
    const wrongSignature = await signWithdrawRequest(
      requestParams,
      spender.address,
      wrongSigner
    )

    await expect(
      spender.write.signWithdrawPayloadHash(
        [
          requestParams,
          gasSettings,
          0,
          oracleWallet.account.address,
          wrongSignature,
        ],
        { account: caller.account }
      )
    ).to.be.rejectedWith("InvalidOracleSignature")
  })

  it("should revert with InvalidOracleSignature when params don't match signature", async function () {
    const { allocator, caller, oracleWallet, requestParams, spender } =
      await loadFixture(deployAllocatorSpender)

    await allocator.write.init()
    await time.increase(await allocator.read.delay())

    // Sign with correct oracle but different params
    const tamperedParams = { ...requestParams, amount: 999n }
    const signature = await signWithdrawRequest(
      tamperedParams,
      spender.address,
      oracleWallet
    )

    // Call with original params but tampered signature
    await expect(
      spender.write.signWithdrawPayloadHash(
        [
          requestParams,
          gasSettings,
          0,
          oracleWallet.account.address,
          signature,
        ],
        { account: caller.account }
      )
    ).to.be.rejectedWith("InvalidOracleSignature")
  })
})
