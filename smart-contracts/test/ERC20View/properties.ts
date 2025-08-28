import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { Address, keccak256 } from 'viem'

describe('ERC20View Properties', function () {
  async function deployHubWithERC20View() {
    const [admin, operatorUser, regularUser] = await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    // Add operator role to operatorUser
    const OPERATOR_ROLE = keccak256('OPERATOR_ROLE')
    const addOperatorHash = await hub.write.grantRole(
      [OPERATOR_ROLE, operatorUser.account.address as Address],
      { account: admin.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOperatorHash })

    const EDITOR_ROLE = keccak256('EDITOR_ROLE')
    const addEditorHash = await hub.write.grantRole(
      [EDITOR_ROLE, admin.account.address as Address],
      { account: admin.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: addEditorHash })

    return { admin, hub, operatorUser, publicClient, regularUser }
  }

  it('creates ERC20View with correct default name, symbol and decimals', async function () {
    const { hub, operatorUser, regularUser, publicClient, admin } =
      await loadFixture(deployHubWithERC20View)

    const tokenId = 999n

    const expectedName = `Hub Token #${tokenId.toString()}`
    const expectedSymbol = `HTK${tokenId.toString()}`
    const expectedDecimals = 18

    const setMetadataTx = await hub.write.setTokenMetadata(
      [
        tokenId,
        {
          decimals: expectedDecimals,
          name: expectedName,
          symbol: expectedSymbol,
        },
      ],
      { account: admin.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: setMetadataTx })

    // Mint tokens to trigger ERC20View creation
    const mintTx = await hub.write.mint(
      [regularUser.account.address, tokenId, 100n],
      { account: operatorUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintTx })

    // Get the ERC20View address
    const erc20ViewAddress = (await hub.read.erc20Views([tokenId])) as Address

    // Get the ERC20View contract
    const erc20View = await hre.viem.getContractAt(
      'ERC20View',
      erc20ViewAddress
    )

    // Verify token properties
    const name = await erc20View.read.name()
    const symbol = await erc20View.read.symbol()
    const decimals = await erc20View.read.decimals()

    expect(name).to.equal(expectedName)
    expect(symbol).to.equal(expectedSymbol)
    expect(decimals).to.equal(expectedDecimals)
  })
})
