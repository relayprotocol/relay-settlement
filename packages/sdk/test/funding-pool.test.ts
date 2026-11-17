import { describe, expect, it } from "vitest"
import { keccak256, toHex } from "viem"

import {
  DrawLegKind,
  PoolDrawResolverExecution,
  decodePoolDrawResolverData,
  decodePoolDrawResolverExecution,
  encodeFundingPoolDrawAuthorization,
  encodePoolDrawResolverData,
  encodePoolDrawResolverExecution,
  fundingPoolDrawConfigUpdateTypes,
  fundingPoolDrawResolverUpdateTypes,
  getFundingPoolDrawAuthorizationHash,
  getFundingPoolDrawConfigUpdateHash,
  getFundingPoolDrawResolverUpdateHash,
  getFundingPoolDrawRevocationHash,
  getFundingPoolWithdrawalHash,
  getPoolDrawResolverCommitmentNonce,
  getPoolDrawResolverPlanHash,
} from "../src/messages/v2.3/funding-pool"
import { getExecuteAndWithdrawRequestHash } from "../src/messages/v2.3/withdrawal"
import * as sdk from "../src"

// Expected values generated from the Solidity contracts with a Foundry test
// (chain id 31337) calling `FundingPool.hashWithdrawal`,
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
    ).toBe("0x347fc83e26bcfb55a01c19ab40f48bcdfee43a6a83b647e20b6743977611801a")
  })

  it("hashes the Solidity DrawConfigUpdate EIP-712 shape", () => {
    expect(
      getFundingPoolDrawConfigUpdateHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          token: "0x4444444444444444444444444444444444444444",
          authorizer: "0x2222222222222222222222222222222222222222",
          perOrderCap: 50_000_000n,
          budget: 2_000_000_000n,
          expiry: 1_900_000_000n,
          epoch: 3n,
          nonce: 7n,
          deadline: 2_000_000_000n,
        }
      )
    ).toBe("0xcd5f661b4b25090775010e3ef9ed18007115af07aadfb22c47dd5311a76dd9d3")
  })

  // Fixture mirrored by `test_drawAuthorizationHashMatchesSdkFixture` in
  // contracts/relay-chain/test/FundingPool/FundingPool.t.sol — the platform
  // signs this digest per order, so both sides must derive it identically
  it("hashes the Solidity DrawAuthorization EIP-712 shape", () => {
    expect(
      getFundingPoolDrawAuthorizationHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          orderAddress: "0x9999999999999999999999999999999999999999",
          planHash:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
          nonce: 7n,
          deadline: 1_900_000_000n,
        }
      )
    ).toBe("0x5f1c6995884f4040d0720471c804c403f6d83c7f14989b943dd32f32cab7e734")
  })

  // Fixture mirrored by `test_drawAuthorizationEnvelopeMatchesSdkFixture` in
  // contracts/relay-chain/test/FundingPool/FundingPool.t.sol — the pool
  // abi.decodes this envelope, so the layout must match byte for byte
  it("encodes the DrawAuthorization envelope", () => {
    expect(
      keccak256(
        encodeFundingPoolDrawAuthorization(
          {
            account: "0x3333333333333333333333333333333333333333",
            orderAddress: "0x9999999999999999999999999999999999999999",
            planHash:
              "0x0000000000000000000000000000000000000000000000000000000000000001",
            nonce: 7n,
            deadline: 1_900_000_000n,
          },
          "0xaabbcc"
        )
      )
    ).toBe("0x12e1e65c98713446c6e1af1aa89bb5db05e61f49175ee934234b662baa5fba82")
  })

  it("hashes the Solidity DrawResolverUpdate EIP-712 shape", () => {
    expect(
      getFundingPoolDrawResolverUpdateHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          resolver: "0x5555555555555555555555555555555555555555",
          allowed: true,
          epoch: 3n,
          nonce: 8n,
          deadline: 2_000_000_000n,
        }
      )
    ).toBe("0x39c3126664603b97648fc979cef3b8a15727408dc7d85ba8cee683ebc9de3641")
  })

  it("hashes the Solidity DrawRevocation EIP-712 shape", () => {
    expect(
      getFundingPoolDrawRevocationHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          epoch: 3n,
          deadline: 2_000_000_000n,
        }
      )
    ).toBe("0x51a1d7381d0a3825608ae5049ff07673e57f2d104dd393f58307e01ead5bf56e")
  })

  // Fixtures mirrored by `test_drawConfigTypehashesMatchSdkFixtures` in
  // contracts/relay-chain/test/FundingPool/FundingPool.t.sol — the
  // primary type names and field lists must match the Solidity type strings.
  // `DrawRevocation` moved to v2.4 (it gained a nonce) and is checked there
  it.each([
    [
      "DrawConfigUpdate",
      fundingPoolDrawConfigUpdateTypes.DrawConfigUpdate,
      "0x342c027017bc0f827fe315c4d4c6f2e19aba6699bb67191b1009ed32e7a839c1",
    ],
    [
      "DrawResolverUpdate",
      fundingPoolDrawResolverUpdateTypes.DrawResolverUpdate,
      "0x3f1aa20f0d81c90a3255ec38475748a2f4263dfe9911e18e021d5caf84cfa2b1",
    ],
  ] as const)("derives the Solidity %s typehash", (name, fields, typehash) => {
    const encodedType = `${name}(${fields
      .map((field) => `${field.type} ${field.name}`)
      .join(",")})`
    expect(keccak256(toHex(encodedType))).toBe(typehash)
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
      surplusPool: "0x5656565656565656565656565656565656565656",
      surplusAccount: "0x1212121212121212121212121212121212121212",
      salt: "0x000000000000000000000000000000000000000000000000000000000000002a",
    }

    const encoded = encodePoolDrawResolverExecution(execution)
    // Fixture mirrored by `test_executionEncodingMatchesSdkFixture` in
    // contracts/relay-chain/test/PoolResolvers/PoolDrawResolver.t.sol
    expect(keccak256(encoded)).toBe(
      "0x1fc0ce0d00a2547fb5f07a47d1506c86145a87b069f868af9b585b988d755bce"
    )
    // The plan hash the authorizer signs is that same hash of the plan bytes
    expect(getPoolDrawResolverPlanHash(encoded)).toBe(keccak256(encoded))
    expect(decodePoolDrawResolverExecution(encoded)).toEqual(execution)
  })

  it("wraps the execution and per-leg authorizations into the resolver data", () => {
    const executionData = encodePoolDrawResolverExecution({
      legs: [],
      calls: [],
      surplusPool: "0x0000000000000000000000000000000000000000",
      surplusAccount: "0x0000000000000000000000000000000000000000",
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
      surplusPool: "0x0000000000000000000000000000000000000000",
      surplusAccount: "0x0000000000000000000000000000000000000000",
      salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    })
    expect(keccak256(encoded)).toBe(
      "0x7331d610cb5b94931dd18390c544d76c8205c1ac2ce32a0df5b920bcb6be6323"
    )
  })

  // The relayer consumes these through the package root, not the deep module
  // path this file imports from, so the barrel must carry every helper
  it("exports the draw authorization helpers from the package root", () => {
    expect(sdk.encodeFundingPoolDrawAuthorization).toBe(
      encodeFundingPoolDrawAuthorization
    )
    expect(sdk.getPoolDrawResolverPlanHash).toBe(getPoolDrawResolverPlanHash)
    expect(sdk.getFundingPoolDrawAuthorizationHash).toBe(
      getFundingPoolDrawAuthorizationHash
    )
    expect(sdk.fundingPoolDrawAuthorizationTypes.DrawAuthorization).toEqual([
      { name: "account", type: "address" },
      { name: "orderAddress", type: "address" },
      { name: "planHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ])
  })

  // Fixture mirrored by `test_commitmentNonceMatchesSdkFixture` in
  // contracts/relay-chain/test/PoolResolvers/PoolDrawResolver.t.sol — both sides
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
