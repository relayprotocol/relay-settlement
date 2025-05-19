import { expect } from 'chai'
import { tokenIdTestCases, addressesTestCases } from '@relay-protocol/fixtures'

import { generateTokenId, generateAddress } from '@relay-protocol/hub-utils'
import hre from 'hardhat'

describe('Token ID Generation', () => {
  let utils: any

  before(async () => {
    utils = await hre.viem.deployContract('Utils')
  })

  tokenIdTestCases.forEach(({ input, expectedValue, name }, i) => {
    describe(name, () => {
      it('token ID should be the same token in lib and contract', async () => {
        const tokenId = generateTokenId(input)
        const solidityTokenId = await utils.read.generateTokenId([
          input.family,
          input.chainId,
          input.address,
        ])
        expect(tokenId).to.equal(solidityTokenId)
        expect(tokenId).to.equal(expectedValue)
        expect(solidityTokenId).to.equal(expectedValue)
      })
    })
  })
})

describe('Virtual Address Generation', () => {
  let utils: any

  before(async () => {
    utils = await hre.viem.deployContract('Utils')
  })

  addressesTestCases.forEach(({ input, expectedAddress, name }, i) => {
    describe(name, () => {
      it('address should be identical in lib and contract', async () => {
        const virtualAddress = generateAddress(input)
        const solidityVirtualAddress = await utils.read.generateAddress([
          input.family,
          input.chainId,
          input.address,
        ])
        expect(virtualAddress).to.equal(virtualAddress)
        expect(virtualAddress).to.equal(expectedAddress)
        expect(solidityVirtualAddress).to.equal(expectedAddress)
      })
    })
  })
})
