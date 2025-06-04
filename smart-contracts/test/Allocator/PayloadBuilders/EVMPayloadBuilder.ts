import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import {
  decodeAbiParameters,
  getAddress,
  hashMessage,
  hashTypedData,
  hexToBytes,
  parseUnits,
  zeroAddress,
} from 'viem'

const ONE_WEEK_SECONDS = 60 * 60 * 24 * 7
const CALL_REQUEST_ABI = [
  {
    components: [
      {
        components: [
          { name: 'to', type: 'address' },
          { name: 'data', type: 'bytes' },
          { name: 'value', type: 'uint256' },
          { name: 'allowFailure', type: 'bool' },
        ],
        name: 'calls',
        type: 'tuple[]',
      },
      { name: 'nonce', type: 'uint256' },
      { name: 'expiration', type: 'uint256' },
    ],
    type: 'tuple',
  },
]

describe('Allocator EVMPayloadBuilder', function () {
  async function deployAllocator() {
    const [escrow, receiver] = await hre.viem.getWalletClients()

    const publicClient = await hre.viem.getPublicClient()

    const payloadBuilder = await hre.viem.deployContract('EVMPayloadBuilder')
    const myToken = await hre.viem.deployContract('MyToken', [])

    return {
      escrow,
      myToken,
      payloadBuilder,
      publicClient,
      receiver,
    }
  }

  describe('buildPayload()', function () {
    it('should build a payload when using the native currency', async () => {
      const { payloadBuilder, escrow, receiver, publicClient } =
        await loadFixture(deployAllocator)

      const amount = parseUnits('0.1', 18)
      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        escrow.account.address, // escrow
        zeroAddress, // currency
        amount, // amount
        receiver.account.address, // receiver
        '0x', // data
      ])
      const balanceBefore = await publicClient.getBalance({
        address: receiver.account.address,
      })
      const [decodedPayload] = decodeAbiParameters(CALL_REQUEST_ABI, payload)
      // Far enough in the future.
      expect(Number(decodedPayload.expiration)).to.be.greaterThan(
        Date.now() / 1000 + ONE_WEEK_SECONDS
      )
      // And now check the calls:
      expect(decodedPayload.calls.length).to.equal(1)
      const [call] = decodedPayload.calls
      expect(call.to).to.equal(getAddress(receiver.account.address))
      expect(call.value).to.equal(amount)
      expect(call.allowFailure).to.equal(false)

      await escrow.sendTransaction({
        data: call.data,
        to: call.to,
        value: call.value,
      })

      const balanceAfter = await publicClient.getBalance({
        address: receiver.account.address,
      })
      expect(balanceAfter).to.equal(balanceBefore + amount)
    })

    it('should build a payload when using an ERC20 token', async () => {
      const { payloadBuilder, escrow, receiver, myToken } =
        await loadFixture(deployAllocator)

      const amount = parseUnits('1337', 18)
      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        escrow.account.address, // escrow
        myToken.address, // currency
        amount, // amount
        receiver.account.address, // receiver
        '0x', // data
      ])
      const balanceBefore = await myToken.read.balanceOf([
        receiver.account.address,
      ])
      const [decodedPayload] = decodeAbiParameters(CALL_REQUEST_ABI, payload)

      // Far enough in the future.
      expect(Number(decodedPayload.expiration)).to.be.greaterThan(
        Date.now() / 1000 + 60 * 60 * 24 * 8
      )
      // And now check the calls:
      expect(decodedPayload.calls.length).to.equal(1)
      const [call] = decodedPayload.calls
      expect(call.to).to.equal(getAddress(myToken.address))
      expect(call.value).to.equal(0n)
      expect(call.allowFailure).to.equal(false)

      await escrow.sendTransaction({
        data: call.data,
        to: call.to,
        value: call.value,
      })

      const balanceAfter = await myToken.read.balanceOf([
        receiver.account.address,
      ])
      expect(balanceAfter).to.equal(balanceBefore + amount)
    })
  })

  describe('hashesToSign()', function () {
    it('should hash a payload correctly using EIP712', async () => {
      const { payloadBuilder, escrow, receiver } =
        await loadFixture(deployAllocator)

      const amount = parseUnits('0.1', 18)
      const chainId = 1n // Mainnet chain ID
      const payload = await payloadBuilder.read.buildPayload([
        chainId, // chainId
        escrow.account.address, // escrow
        zeroAddress, // currency
        amount, // amount
        receiver.account.address, // receiver
        '0x', // data
      ])

      // Let's now check that the hash corresponds to what the EVM would generate when asking the user to sign the payload.
      const hashes = await payloadBuilder.read.hashesToSign([
        chainId, // chainId
        escrow.account.address, // escrow
        payload,
      ])
      expect(hashes).to.be.a('array')
      expect(hashes.length).to.equal(1)

      const [message] = decodeAbiParameters(
        [
          {
            components: [
              {
                components: [
                  { name: 'to', type: 'address' },
                  { name: 'data', type: 'bytes' },
                  { name: 'value', type: 'uint256' },
                  { name: 'allowFailure', type: 'bool' },
                ],
                name: 'calls',
                type: 'tuple[]',
              },
              { name: 'nonce', type: 'uint256' },
              { name: 'expiration', type: 'uint256' },
            ],
            name: 'callRequest',
            type: 'tuple',
          },
        ],
        payload
      )

      const reconstructedHash = hashTypedData({
        domain: {
          chainId: Number(chainId),
          name: 'RelayEscrow',
          verifyingContract: escrow.account.address,
          version: '1',
        },
        message,
        primaryType: 'CallRequest',
        types: {
          Call: [
            { name: 'to', type: 'address' },
            { name: 'data', type: 'bytes' },
            { name: 'value', type: 'uint256' },
            { name: 'allowFailure', type: 'bool' },
          ],
          CallRequest: [
            { name: 'calls', type: 'Call[]' },
            { name: 'nonce', type: 'uint256' },
            { name: 'expiration', type: 'uint256' },
          ],
        },
      })

      expect(hashes[0]).to.equal(reconstructedHash)
    })
  })

  describe('toAddress', function () {
    it('should return the address of the payload builder', async () => {
      const { payloadBuilder } = await loadFixture(deployAllocator)
      const address = await payloadBuilder.read.toAddress([
        '0x81Dd955D02D337DB81BA6c9C5F6213E647672052',
      ])
      expect(address).to.equal('0x81Dd955D02D337DB81BA6c9C5F6213E647672052')
    })
  })
})
