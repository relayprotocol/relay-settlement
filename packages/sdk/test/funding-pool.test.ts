import { describe, expect, it } from "vitest"
import { keccak256 } from "viem"

import {
  DrawLegKind,
  PoolDrawResolverExecution,
  decodePoolDrawResolverData,
  decodePoolDrawResolverExecution,
  encodePoolDrawResolverData,
  encodePoolDrawResolverExecution,
  getFundingPoolDrawAuthorizationHash,
  getFundingPoolSponsorshipConfigUpdateHash,
  getFundingPoolSponsorshipResolverUpdateHash,
  getFundingPoolWithdrawalHash,
  getPoolDrawResolverCommitmentNonce,
} from "../src/messages/v2.3/funding-pool"
import { getExecuteAndWithdrawRequestHash } from "../src/messages/v2.3/withdrawal"

// Expected values generated from the Solidity contracts with a Foundry test
// (chain id 31337) calling `RelayFundingPool.hashWithdrawal`,
// `RelayExecutor.hashExecuteAndWithdrawRequest`, and
// `keccak256(abi.encode(PoolDrawResolver.Execution))`

describe("funding pool helpers", () => {
  it("hashes the Solidity PoolWithdrawal EIP-712 shape", () => {
    expect(
      getFundingPoolWithdrawalHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          token: "0x4444444444444444444444444444444444444444",
          amount: 1_000_000n,
          recipient: "0x5555555555555555555555555555555555555555",
          nonce: 7n,
          deadline: 2_000_000_000n,
        }
      )
    ).toBe("0xbf3a8c5753e01d1e57bca04b80127256061f32b6a00252b1f799f529d834c5cc")
  })

  it("hashes the Solidity SponsorshipConfigUpdate EIP-712 shape", () => {
    expect(
      getFundingPoolSponsorshipConfigUpdateHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          token: "0x4444444444444444444444444444444444444444",
          authorizer: "0x2222222222222222222222222222222222222222",
          perOrderCap: 50_000_000n,
          budget: 2_000_000_000n,
          expiry: 1_900_000_000n,
          nonce: 7n,
          deadline: 2_000_000_000n,
        }
      )
    ).toBe("0xc3afa856adedc926115e74f6a4357e34c14ee01ace83783e7af7f731ea2a4769")
  })

  // Fixture mirrored by `test_drawAuthorizationHashMatchesSdkFixture` in
  // smart-contracts/test/RelayFundingPool/RelayFundingPool.t.sol — the platform
  // signs this digest per order, so both sides must derive it identically
  it("hashes the Solidity DrawAuthorization EIP-712 shape", () => {
    expect(
      getFundingPoolDrawAuthorizationHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          orderAddress: "0x9999999999999999999999999999999999999999",
        }
      )
    ).toBe("0xb530232c7a8705c344cff4fd54c62e3b276647566e8013ff846baa11aa690a8e")
  })

  it("hashes the Solidity SponsorshipResolverUpdate EIP-712 shape", () => {
    expect(
      getFundingPoolSponsorshipResolverUpdateHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          resolver: "0x5555555555555555555555555555555555555555",
          allowed: true,
          nonce: 8n,
          deadline: 2_000_000_000n,
        }
      )
    ).toBe("0x5f0af5dd252b51c4c4519a0f9dcc4621126b506412c67d952a25f6e00c168a4e")
  })

  it("encodes the PoolDrawResolver Execution tuple", () => {
    const execution: PoolDrawResolverExecution = {
      legs: [
        {
          pool: "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
          account: "0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd",
          kind: DrawLegKind.FIXED,
          tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          tokenOut: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF",
          amount: 4_000_000n,
          amountOutMinimum: 3_900_000n,
          calls: [
            {
              to: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
              data: "0x01020304",
            },
          ],
        },
        {
          pool: "0x5656565656565656565656565656565656565656",
          account: "0x1212121212121212121212121212121212121212",
          kind: DrawLegKind.SHORTFALL_TO_TARGET,
          tokenIn: "0x3434343434343434343434343434343434343434",
          tokenOut: "0x3434343434343434343434343434343434343434",
          amount: 10_000_000_000n,
          amountOutMinimum: 0n,
          calls: [],
        },
      ],
      calls: [
        {
          to: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
          data: "0x05060708",
        },
      ],
      salt: "0x000000000000000000000000000000000000000000000000000000000000002a",
    }

    const encoded = encodePoolDrawResolverExecution(execution)
    // Fixture mirrored by `test_executionEncodingMatchesSdkFixture` in
    // smart-contracts/test/PoolResolvers/PoolDrawResolver.t.sol
    expect(keccak256(encoded)).toBe(
      "0x79bea5134464aa47b9d4993ae0f08bd33f0a9469f675a0a3de105aabc05f8ac5"
    )
    expect(decodePoolDrawResolverExecution(encoded)).toEqual(execution)
  })

  it("wraps the execution and per-leg authorizations into the resolver data", () => {
    const executionData = encodePoolDrawResolverExecution({
      legs: [],
      calls: [],
      salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
    })
    // Two legs naming the same account carry the same bytes; the array is
    // parallel to the legs, outside the committed execution
    const authorizations = ["0xaabbcc", "0xaabbcc"] as const

    const data = encodePoolDrawResolverData(executionData, [...authorizations])
    expect(decodePoolDrawResolverData(data)).toEqual({
      executionData,
      authorizations: [...authorizations],
    })

    // The commitment nonce hashes the execution alone: attaching or changing
    // authorizations must not move it
    expect(
      getPoolDrawResolverCommitmentNonce(
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        executionData
      )
    ).toBe(
      getPoolDrawResolverCommitmentNonce(
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        decodePoolDrawResolverData(
          encodePoolDrawResolverData(executionData, ["0xdeadbeef"])
        ).executionData
      )
    )
  })

  it("encodes the empty Execution tuple", () => {
    const encoded = encodePoolDrawResolverExecution({
      legs: [],
      calls: [],
      salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    })
    expect(keccak256(encoded)).toBe(
      "0xaa24fcd8c28149a79d01f9c0cf6bb6702236970a1d13e5ccb1aaa71eb3202763"
    )
  })

  // Fixture mirrored by `test_commitmentNonceMatchesSdkFixture` in
  // smart-contracts/test/PoolResolvers/PoolDrawResolver.t.sol — both sides
  // must derive `keccak256(resolver ‖ keccak256(payload))`
  it("derives the payload commitment nonce the resolver verifies", () => {
    expect(
      getPoolDrawResolverCommitmentNonce(
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        "0xdeadbeef"
      )
    ).toBe("0xe4890326743cc98f49d9488f5eb62e5525cdcc97748aadbd8b2a14baaa9d458b")
  })
})

describe("getExecuteAndWithdrawRequestHash", () => {
  it("hashes the Solidity ExecuteAndWithdrawRequest EIP-712 shape", () => {
    expect(
      getExecuteAndWithdrawRequestHash(
        31337,
        "0x2e234DAe75C793f67A35089C9d99245E1C58470b",
        {
          inChainId: "8453",
          inCurrency: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          outChainId: "42161",
          outCurrency: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
          outAmountMinimum: "10000000000",
          depository: "0x8888888888888888888888888888888888888888",
          orderAddress: "0x9999999999999999999999999999999999999999",
          receiver: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          data: "0xdeadbeef",
          fees: [
            {
              recipient: "0x6666666666666666666666666666666666666666",
              amount: "40",
            },
            {
              recipient: "0x7777777777777777777777777777777777777777",
              amount: "2",
            },
          ],
          nonce:
            "0x000000000000000000000000000000000000000000000000000000000000000b",
          deadline: "2000000000",
        }
      )
    ).toBe("0x39f712eb3f19182658fd17177c717ecd3f1f6689448d9646fd50483386a4b56e")
  })
})
