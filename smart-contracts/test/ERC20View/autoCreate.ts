import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { Address, keccak256 } from 'viem'

describe('ERC20View Auto Creation', function () {
  async function deployHub() {
    const [admin, operatorUser, regularUser] = await hre.viem.getWalletClients()
    const hub = await hre.viem.deployContract('Hub', [admin.account.address])
    const publicClient = await hre.viem.getPublicClient()

    // Add operator role to operatorUser
    const OPERATOR_ROLE = keccak256('OPERATOR_ROLE')
    const addOracleHash = await hub.write.grantRole(
      [OPERATOR_ROLE, operatorUser.account.address as Address],
      { account: admin.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: addOracleHash })

    return { admin, hub, operatorUser, publicClient, regularUser }
  }

  it('automatically creates ERC20View on first token operation', async function () {
    const { hub, operatorUser, regularUser, publicClient } =
      await loadFixture(deployHub)

    const tokenId = 999n

    // Verify ERC20View doesn't exist yet
    const beforeAddress = await hub.read.erc20Views([tokenId])
    expect(beforeAddress).to.equal('0x0000000000000000000000000000000000000000')

    // Mint tokens to trigger ERC20View creation
    const mintTx = await hub.write.mint(
      [regularUser.account.address, tokenId, 100n],
      { account: operatorUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintTx })

    // Verify ERC20View was created
    const afterAddress = await hub.read.erc20Views([tokenId])
    expect(afterAddress).to.not.equal(
      '0x0000000000000000000000000000000000000000'
    )

    // Verify ERC20ViewCreated event was emitted
    const events = await publicClient.getContractEvents({
      abi: hub.abi,
      address: hub.address,
      eventName: 'ERC20ViewCreated',
      fromBlock: 'earliest',
      toBlock: 'latest',
    })

    const event = events.find((e) => e.args.tokenId === tokenId)
    expect(event).to.not.equal(undefined)
    expect(event!.args.erc20View).to.equal(afterAddress)
  })

  it('creates ERC20View for different token IDs', async function () {
    const { hub, operatorUser, regularUser, publicClient } =
      await loadFixture(deployHub)

    const tokenId1 = 111n
    const tokenId2 = 222n

    // Mint tokens with first ID
    const mintTx1 = await hub.write.mint(
      [regularUser.account.address, tokenId1, 100n],
      { account: operatorUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintTx1 })

    // Mint tokens with second ID
    const mintTx2 = await hub.write.mint(
      [regularUser.account.address, tokenId2, 100n],
      { account: operatorUser.account }
    )
    await publicClient.waitForTransactionReceipt({ hash: mintTx2 })

    // Get ERC20View addresses
    const address1 = await hub.read.erc20Views([tokenId1])
    const address2 = await hub.read.erc20Views([tokenId2])

    // Verify both were created and are different
    expect(address1).to.not.equal('0x0000000000000000000000000000000000000000')
    expect(address2).to.not.equal('0x0000000000000000000000000000000000000000')
    expect(address1).to.not.equal(address2)
  })
})
