import hre from "hardhat"
import { expect } from "chai"
import { keccak256 } from "viem"

describe("Allocator stringifyBytes()", function () {
  it("should correctly convert mixed case hex bytes to a string", async function () {
    const chainSignatures = await hre.viem.deployContract("ChainSignatures", [])

    const bytes = keccak256("0x1A2b3C4d")
    const result = await chainSignatures.read.stringifyBytes([bytes])

    // Expected decimal values:
    expect(result).to.equal(
      "d17bb4458f5e516e4f1457be13b4a9b87688595099d1bc34c84b03dccc26ec7a"
    )
  })
})
