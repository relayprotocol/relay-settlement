import { addressesTestCases, tokenIdTestCases } from "@relay-protocol/fixtures"
import { expect } from "chai"

import { generateAddress, generateTokenId } from "@relay-protocol/hub-utils"
import hre from "hardhat"

describe("Token ID Generation", () => {
  let utils: any

  before(async () => {
    utils = await hre.viem.deployContract("Utils")
  })

  tokenIdTestCases.forEach(({ input, expectedValue, name }) => {
    describe(name, () => {
      it("token ID should be the same token in lib and contract", async () => {
        const tokenId = generateTokenId(input)
        const solidityTokenId = await utils.read.generateTokenId([
          input.family,
          input.chainId,
          input.address,
        ])
        expect(tokenId).to.equal(expectedValue)
        expect(solidityTokenId).to.equal(expectedValue)
      })
    })
  })
})

describe("Virtual Address Generation", () => {
  let utils: any

  before(async () => {
    utils = await hre.viem.deployContract("Utils")
  })

  addressesTestCases.forEach(({ input, expectedAddress, name }) => {
    describe(name, () => {
      it("address should be identical in lib and contract", async () => {
        const virtualAddress = generateAddress(input)
        const solidityVirtualAddress = await utils.read.generateAddress([
          input.family,
          input.chainId,
          input.address,
        ])
        expect(virtualAddress).to.equal(expectedAddress)
        expect(solidityVirtualAddress).to.equal(expectedAddress)
      })
    })
  })

  describe("toAddress", function () {
    it("should return the address of the payload builder", async () => {
      const address = await utils.read.toAddress([
        // eslint-disable-next-line evm-address-to-checksummed/evm-address-to-checksummed
        "0x81dd955d02d337db81ba6c9c5f6213e647672052", // lowercase on purpose
      ])
      expect(address).to.equal("0x81Dd955D02D337DB81BA6c9C5F6213E647672052")
    })
  })
})
