import * as bitcoin from 'bitcoinjs-lib'

import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { decodeAbiParameters, encodeAbiParameters, zeroAddress } from 'viem'
import {
  BITCOIN_TRANSACTION_ABI,
  txidToBytes32,
  BITCOIN_TRANSACTION_PARAMS_ABI,
  decodeUint64LE,
} from '../../../lib/bitcoin'

// https://blockstream.info/api/address/1Cw8ACW5MK1kRbeCKdp5wTAAG4t3c7pUfA/utxo
const utxos = [
  {
    status: {
      block_hash:
        '0000000000000000000119286b2465c278323eba0fd50a4fcc35266ecd0d4ad0',
      block_height: 897275,
      block_time: 1747583102,
      confirmed: true,
    },
    txid: 'ec37cafc98e406a048e2b2592a23be7eb2c0f1e0754b0710bb2ea4efb3a9371d',
    value: 33638,
    vout: 0,
  },
  {
    status: {
      block_hash:
        '00000000000000000000fb9cc316eccb18fc65e171a436ded408477283b9c1dc',
      block_height: 898648,
      block_time: 1748380664,
      confirmed: true,
    },
    txid: '529a486bd7c230b4ab3ef70f48a577a2057aa4dc06414da75d7c7861d6730bcb',
    value: 79687,
    vout: 0,
  },
]

// get scriptpubkey
// https://blockstream.info/api/tx/ec37cafc98e406a048e2b2592a23be7eb2c0f1e0754b0710bb2ea4efb3a9371d
const scriptPubKey = '0x76a914632a250a7f721ae8583ad911950eeeb82c00e54788ac'

describe('Allocator BitcoinPayloadBuilder', function () {
  async function deployPayloadBuilder() {
    const [depository] = await hre.viem.getWalletClients()

    const publicClient = await hre.viem.getPublicClient()

    const bitcoinAllocatorAddress = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' // example
    const changeScript = bitcoin.address.toOutputScript(
      bitcoinAllocatorAddress,
      bitcoin.networks.bitcoin
    )

    const payloadBuilder = await hre.viem.deployContract(
      'BitcoinPayloadBuilder',
      [changeScript.toString('base64')]
    )

    const bitcoinRecipientAddress = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' // example
    const receiverScript = bitcoin.address.toOutputScript(
      bitcoinRecipientAddress,
      bitcoin.networks.bitcoin
    )

    return {
      bitcoinAllocatorAddress,
      bitcoinRecipientAddress,
      depository,
      payloadBuilder,
      publicClient,
      receiverScript: receiverScript.toString('base64'),
    }
  }

  describe('buildPayload()', function () {
    it('should fail if no utxos are submitted', async () => {
      const { payloadBuilder, receiverScript } =
        await loadFixture(deployPayloadBuilder)

      const amount = 1n
      await expect(
        payloadBuilder.read.buildPayload([
          1n, // chainId
          zeroAddress, // depository
          zeroAddress, // currency
          amount, // amount
          receiverScript, // receiver
          encodeAbiParameters(
            [BITCOIN_TRANSACTION_PARAMS_ABI],
            [
              {
                feeRate: 0n,
                utxos: [], // no utxos
              },
            ]
          ), // data
        ])
      ).to.be.rejectedWith(`InsufficientUTXOValue(0, ${amount})`)
    })

    it('should fail if the utxos total value is insufficient', async () => {
      const { payloadBuilder, receiverScript } =
        await loadFixture(deployPayloadBuilder)

      const amount = 113327n

      const utxosTotalValue = utxos.reduce(
        (total, utxo) => total + BigInt(utxo.value),
        0n
      )
      expect(Number(utxosTotalValue)).to.be.lessThan(Number(amount))

      await expect(
        payloadBuilder.read.buildPayload([
          1n, // chainId
          zeroAddress, // depository
          zeroAddress, // currency
          amount, // amount
          receiverScript,
          encodeAbiParameters(
            [BITCOIN_TRANSACTION_PARAMS_ABI],
            [
              {
                feeRate: 0n,
                utxos: utxos.map((utxo) => ({
                  index: utxo.vout,
                  scriptPubKey,
                  txid: txidToBytes32(utxo.txid),
                  value: BigInt(utxo.value),
                })), // use the utxos data
              },
            ] // data
          ),
        ])
      ).to.be.rejectedWith(
        `InsufficientUTXOValue(${utxosTotalValue}, ${amount})`
      )
    })

    it('should build a payload without change if the amount is sufficient', async () => {
      const { payloadBuilder, receiverScript } =
        await loadFixture(deployPayloadBuilder)

      const utxosTotalValue = utxos.reduce(
        (total, utxo) => total + BigInt(utxo.value),
        0n
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        zeroAddress, // depository
        '', // currency
        utxosTotalValue, // amount
        receiverScript, // receiver
        encodeAbiParameters(
          [BITCOIN_TRANSACTION_PARAMS_ABI],
          [
            {
              feeRate: 0n, // no fee rate
              utxos: utxos.map((utxo) => ({
                index: utxo.vout,
                scriptPubKey,
                txid: txidToBytes32(utxo.txid),
                value: BigInt(utxo.value),
              })), // use the utxos data
            },
          ]
        ),
      ])

      // Let's now parse the payload to check that it is correct
      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )
      expect(transaction.inputs.length).to.equal(utxos.length)
      expect(transaction.outputs.length).to.equal(1)
      expect(decodeUint64LE(transaction.outputs[0].value)).to.equal(
        utxosTotalValue
      )
    })

    it('should build a payload with change if the amount is less than the total value of utxos', async () => {
      const { payloadBuilder, receiverScript } =
        await loadFixture(deployPayloadBuilder)

      const utxosTotalValue = utxos.reduce(
        (total, utxo) => total + BigInt(utxo.value),
        0n
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        zeroAddress, // depository
        '', // currency
        (utxosTotalValue * 2n) / 3n, // amount
        receiverScript, // receiver
        encodeAbiParameters(
          [BITCOIN_TRANSACTION_PARAMS_ABI],
          [
            {
              feeRate: 0n, // no fee rate
              utxos: utxos.map((utxo) => ({
                index: utxo.vout,
                scriptPubKey,
                txid: txidToBytes32(utxo.txid),
                value: BigInt(utxo.value),
              })), // use the utxos data
            },
          ] // data
        ),
      ])

      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )
      expect(transaction.inputs.length).to.equal(utxos.length)
      expect(transaction.outputs.length).to.equal(2) // There should be change!
    })

    it('should take fees into account when building the payload', async () => {
      const { payloadBuilder, receiverScript } =
        await loadFixture(deployPayloadBuilder)

      const utxosTotalValue = utxos.reduce(
        (total, utxo) => total + BigInt(utxo.value),
        0n
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        zeroAddress, // depository
        '', // currency
        utxosTotalValue, // amount
        receiverScript, // receiver
        encodeAbiParameters(
          [BITCOIN_TRANSACTION_PARAMS_ABI],
          [
            {
              feeRate: 1n, // 1 satoshi per byte
              utxos: utxos.map((utxo) => ({
                index: utxo.vout,
                scriptPubKey,
                txid: txidToBytes32(utxo.txid),
                value: BigInt(utxo.value),
              })), // use the utxos data
            },
          ]
        ),
      ])

      // Let's now parse the payload to check that it is correct
      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )
      expect(transaction.inputs.length).to.equal(utxos.length)
      expect(transaction.outputs.length).to.equal(1)
      expect(Number(decodeUint64LE(transaction.outputs[0].value))).to.lessThan(
        Number(utxosTotalValue)
      )
    })

    it('should fail if the fees are not sufficient', async () => {
      const { payloadBuilder, receiverScript } =
        await loadFixture(deployPayloadBuilder)

      const utxosTotalValue = utxos.reduce(
        (total, utxo) => total + BigInt(utxo.value),
        0n
      )

      const feeRate = 1000n // 1000 satoshis per byte

      await expect(
        payloadBuilder.read.buildPayload([
          1n, // chainId
          zeroAddress, // depository
          '', // currency
          utxosTotalValue, // amount
          receiverScript, // receiver
          encodeAbiParameters(
            [BITCOIN_TRANSACTION_PARAMS_ABI],
            [
              {
                feeRate,
                utxos: utxos.map((utxo) => ({
                  index: utxo.vout,
                  scriptPubKey,
                  txid: txidToBytes32(utxo.txid),
                  value: BigInt(utxo.value),
                })), // use the utxos data
              },
            ]
          ),
        ])
      ).to.be.rejectedWith(`FeesTooHigh(${utxosTotalValue}, 340000)`)
    })
  })

  describe('hashesToSign()', function () {
    it('should return the correct hashes to sign', async () => {
      const {
        payloadBuilder,
        receiverScript,
        bitcoinRecipientAddress,
        bitcoinAllocatorAddress,
      } = await loadFixture(deployPayloadBuilder)

      const amount = 50000n
      const payload = await payloadBuilder.read.buildPayload([
        1n,
        zeroAddress,
        '',
        amount,
        receiverScript,
        encodeAbiParameters(
          [BITCOIN_TRANSACTION_PARAMS_ABI],
          [
            {
              feeRate: 0n, // no fee rate
              utxos: utxos.map((utxo) => ({
                index: utxo.vout,
                scriptPubKey,
                txid: txidToBytes32(utxo.txid),
                value: BigInt(utxo.value),
              })), // use the utxos data
            },
          ]
        ),
      ])

      const contractHashes = await payloadBuilder.read.hashesToSign([
        1n,
        zeroAddress,
        payload,
      ])

      // Build a raw transaction with bitcoinjs-lib (not PSBT)
      const tx = new bitcoin.Transaction()
      tx.version = 1

      // Add inputs in the same order as the contract
      utxos.forEach((utxo) => {
        tx.addInput(
          Buffer.from(utxo.txid, 'hex').reverse(), // reverse for little-endian
          utxo.vout,
          0xffffffff // sequence
        )
      })

      // Add outputs
      const outputScript = bitcoin.address.toOutputScript(
        bitcoinRecipientAddress
      )
      tx.addOutput(outputScript, Number(amount))

      // Add change output
      const totalInput = utxos.reduce(
        (sum, utxo) => sum + BigInt(utxo.value),
        0n
      )
      const change = totalInput - amount
      if (change > 0n) {
        const changeScript = bitcoin.address.toOutputScript(
          bitcoinAllocatorAddress
        )
        tx.addOutput(changeScript, Number(change))
      }

      // Get sighashes from bitcoinjs for each input
      const bitcoinjsHashes = []
      for (let i = 0; i < utxos.length; i++) {
        const sighash = tx.hashForSignature(
          i,
          Buffer.from(scriptPubKey.slice(2), 'hex'),
          bitcoin.Transaction.SIGHASH_ALL
        )
        bitcoinjsHashes.push('0x' + sighash.toString('hex'))
      }

      // Compare the results
      expect(contractHashes.length).to.equal(bitcoinjsHashes.length)

      contractHashes.forEach((contractHash, i) => {
        expect(contractHash.toLowerCase()).to.equal(
          bitcoinjsHashes[i].toLowerCase()
        )
      })
    })
  })
})
