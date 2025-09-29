import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'

import { deployOracle } from '../helpers/deployOracle'

describe('deploy', function () {
  it('should deploy Oracle contract with correct admin and Hub', async function () {
    const { admin, hub, oracle } = await loadFixture(deployOracle)

    // Check if admin was correctly configured
    const ADMIN_ROLE = await oracle.read.ADMIN_ROLE()
    const hasRole = await oracle.read.hasRole([
      ADMIN_ROLE,
      admin.account.address,
    ])
    expect(hasRole).to.equal(true)

    // Check if the Hub was correctly configured
    const HUB = await oracle.read.HUB()
    expect(HUB.toLowerCase()).to.equal(hub.address.toLowerCase())
  })
})
