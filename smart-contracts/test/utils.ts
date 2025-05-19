import { expect } from 'chai'
import { generateTokenId } from '@relay-protocol/hub-utils'
import { tokenIdTestCases } from '@relay-protocol/fixtures'

import hre from 'hardhat'

describe('Token ID Generation', () => {
  let utils: any

  before(async () => {
    utils = await hre.viem.deployContract('Utils')
  })

  tokenIdTestCases.forEach(({ input, expectedValue, name }) => {
    describe(name, () => {
      it('should produce the same token ID in lib and contract', async () => {
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
