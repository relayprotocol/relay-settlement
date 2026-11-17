import { describe, expect, it } from "vitest"
import { keccak256, toHex } from "viem"

import {
  fundingPoolDrawRevocationTypes,
  getFundingPoolDrawRevocationHash,
  getRandomFundingPoolRevocationNonce,
} from "../src/messages/v2.4/funding-pool"
import * as sdk from "../src"

// Expected value generated from the Solidity contract with a Foundry test
// (chain id 31337) calling `FundingPool.hashDrawRevocation`
describe("funding pool v2.4 helpers", () => {
  it("hashes the Solidity DrawRevocation EIP-712 shape", () => {
    expect(
      getFundingPoolDrawRevocationHash(
        31337,
        "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        {
          account: "0x3333333333333333333333333333333333333333",
          epoch: 3n,
          nonce: 9n,
          deadline: 2_000_000_000n,
        }
      )
    ).toBe("0xfcb95862fa6fe1baf2ad1546bccd96e5af5cba8bf4dd2d51426288f241b50ea6")
  })

  // Mirrored by `test_drawConfigTypehashesMatchSdkFixtures` in
  // contracts/relay-chain/test/FundingPool/FundingPool.t.sol
  it("derives the Solidity DrawRevocation typehash", () => {
    const fields = fundingPoolDrawRevocationTypes.DrawRevocation
    const encodedType = `DrawRevocation(${fields
      .map((field) => `${field.type} ${field.name}`)
      .join(",")})`
    expect(keccak256(toHex(encodedType))).toBe(
      "0x143edb3c92ecc7e1e6722be4c91478cf0bebc79b9fdf1cc651ebd713d025aa0e"
    )
  })

  it("exports the revocation helpers from the package root", () => {
    expect(sdk.getFundingPoolDrawRevocationHash).toBe(
      getFundingPoolDrawRevocationHash
    )
    expect(sdk.getRandomFundingPoolRevocationNonce).toBe(
      getRandomFundingPoolRevocationNonce
    )
    expect(sdk.fundingPoolDrawRevocationTypes.DrawRevocation).toEqual([
      { name: "account", type: "address" },
      { name: "epoch", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ])
  })

  it("picks a revocation nonce with slack above the pool's minimum jump", () => {
    // Mirrors `MIN_DRAW_NONCE_JUMP` / `MAX_DRAW_NONCE_JUMP` on the pool; the
    // random jump starts at twice the minimum so queued signed updates
    // cannot push a signed target under the minimum in practice
    expect(sdk.MIN_FUNDING_POOL_REVOCATION_JUMP).toBe(2n ** 32n)
    expect(sdk.MIN_RANDOM_FUNDING_POOL_REVOCATION_JUMP).toBe(2n ** 33n)
    expect(sdk.MAX_FUNDING_POOL_REVOCATION_JUMP).toBe(2n ** 64n - 1n)
    for (let i = 0; i < 32; i++) {
      const jump = getRandomFundingPoolRevocationNonce(7n) - 7n
      expect(jump >= sdk.MIN_RANDOM_FUNDING_POOL_REVOCATION_JUMP).toBe(true)
      expect(jump <= sdk.MAX_FUNDING_POOL_REVOCATION_JUMP).toBe(true)
    }
  })
})
