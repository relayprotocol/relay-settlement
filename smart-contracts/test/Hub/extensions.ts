import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { keccak256 } from 'viem'

const EDITOR_ROLE = keccak256('EDITOR_ROLE')

describe('extensions', function () {
  async function deployHub() {
    const [admin, editor, attacker] = await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    return {
      admin,
      attacker,
      editor,
      hub,
      publicClient,
    }
  }

  describe('metadata extension', function () {
    it('should not let anyone set metadata', async function () {
      const { hub, attacker } = await loadFixture(deployHub)

      await expect(
        hub.write.setTokenMetadata(
          [
            1n,
            {
              decimals: 18,
              name: 'New Token',
              symbol: 'NT',
            },
          ],
          {
            account: attacker.account,
          }
        )
      ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
    })
    it('should have default metadata for each token', async function () {
      const { hub } = await loadFixture(deployHub)

      expect(await hub.read.name([1n])).to.equal('')
      expect(await hub.read.symbol([1n])).to.equal('')
      expect(await hub.read.decimals([1n])).to.equal(18)
    })
    it('should let an address with the editor role set the metadata', async function () {
      const { hub, admin, editor } = await loadFixture(deployHub)
      await hub.write.grantRole([EDITOR_ROLE, editor.account.address], {
        account: admin.account,
      })

      await hub.write.setTokenMetadata(
        [
          1n,
          {
            decimals: 6,
            name: 'New Token',
            symbol: 'NT',
          },
        ],
        {
          account: editor.account,
        }
      )

      expect(await hub.read.name([1n])).to.equal('New Token')
      expect(await hub.read.symbol([1n])).to.equal('NT')
      expect(await hub.read.decimals([1n])).to.equal(6)
    })
  })

  describe('Content URI Extension', function () {
    it('should not let anyone set contract uri', async function () {
      const { hub, attacker } = await loadFixture(deployHub)

      await expect(
        hub.write.setContractURI(['https://new-uri.com'], {
          account: attacker.account,
        })
      ).to.be.rejectedWith('AccessControlUnauthorizedAccount')
    })
  })
  it('should have default contract URI and token URI for each token', async function () {
    const { hub } = await loadFixture(deployHub)

    expect(await hub.read.contractURI()).to.equal('')
    expect(await hub.read.tokenURI([1n])).to.equal('/1')
  })

  it('should let an address with the editor role set the contract URI', async function () {
    const { hub, admin, editor } = await loadFixture(deployHub)
    await hub.write.grantRole([EDITOR_ROLE, editor.account.address], {
      account: admin.account,
    })

    await hub.write.setContractURI(['https://new-uri.com'], {
      account: editor.account,
    })

    expect(await hub.read.contractURI()).to.equal('https://new-uri.com')
    expect(await hub.read.tokenURI([1n])).to.equal('https://new-uri.com/1')
  })
})
