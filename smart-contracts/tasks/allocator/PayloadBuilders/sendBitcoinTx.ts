import * as secp from 'secp256k1'

import { task } from 'hardhat/config'
import * as bip39 from 'bip39'
import BIP32Factory from 'bip32'
import * as ecc from 'tiny-secp256k1'
import * as bitcoin from 'bitcoinjs-lib'
import { decodeAbiParameters, encodeAbiParameters, zeroAddress } from 'viem'
import {
  BITCOIN_TRANSACTION_ABI,
  fetchUtxo,
  txidToBytes32,
  BITCOIN_TRANSACTION_PARAMS_ABI,
  getBalance,
  estimateFeeRate,
  buildBitcoinTransactionFromPayload,
  addSignedInputsToTransaction,
  broadcastTransaction,
} from '../../../lib/bitcoin'

const network = bitcoin.networks.testnet
const bip32 = BIP32Factory(ecc)

task('bitcoin:send', 'Send Bitcoin to an address').setAction(
  async (_, { viem }) => {
    // Get allocator address
    const seed = bip39.mnemonicToSeedSync(process.env.ALLOCATOR_SEED_PHRASE!)
    const root = bip32.fromSeed(seed, network)
    const account = root.deriveHardened(0)
    const allocator = account.derive(0).derive(0) // m/0'/0/0 = first receiving address
    const allocatorAddress = bitcoin.payments.p2pkh({
      network,
      pubkey: Buffer.from(allocator.publicKey),
    }).address!
    console.log(
      'Allocator Address:',
      allocatorAddress,
      await getBalance(allocatorAddress)
    )

    // Let's now get the UTXOs for the allocator address
    const utxos = await fetchUtxo(allocatorAddress)
    console.log('➡️ UTXOs:', utxos)

    // Compute the change script so we can receive the change back
    const changeScript = bitcoin.address.toOutputScript(
      allocatorAddress,
      network
    )

    // Let's now deploy the BitcoinPayloadBuilder contract
    const payloadBuilder = await viem.deployContract('BitcoinPayloadBuilder', [
      changeScript.toString('base64'),
    ])
    console.log(`🏗️  PayloadBuilder deployed to: ${payloadBuilder.address}`)

    const feeRate = await estimateFeeRate()
    console.log(`💰 Estimated fee rate: ${feeRate} sat/vbyte`)

    // Now we can create a payload to send Bitcoin
    const recipientAddress = 'tb1q6xsu27js50xzvnwfgxrkhwj7a9rrch76wf7xxq'
    const receiverScript = bitcoin.address
      .toOutputScript(recipientAddress, network)
      .toString('base64')

    // Build the payload
    const data = utxos.map((utxo) => ({
      index: utxo.vout,
      scriptPubKey: `0x${utxo.scriptPubKey}`,
      txid: txidToBytes32(utxo.txid),
      value: BigInt(utxo.value),
    }))

    // Pick an amount to send that's less than the total UTXO value...
    const utxosTotalValue = utxos.reduce(
      (total, utxo) => total + BigInt(utxo.value),
      0n
    )
    const amount = BigInt(Math.floor(Math.random() * Number(utxosTotalValue)))

    const payload = await payloadBuilder.read.buildPayload([
      1n, // chainId
      zeroAddress, // escrow
      '', // currency (empty string, not zeroAddress)
      amount, // amount
      receiverScript, // receiver
      encodeAbiParameters(
        [BITCOIN_TRANSACTION_PARAMS_ABI],
        [
          {
            feeRate,
            utxos: data, // we will calculate fee later
          },
        ] // data
      ),
    ])

    const hashes = await payloadBuilder.read.hashesToSign([
      1n,
      zeroAddress,
      payload,
    ])

    const [transaction] = decodeAbiParameters(BITCOIN_TRANSACTION_ABI, payload)
    const tx = buildBitcoinTransactionFromPayload(transaction)

    // Sign all the hashes!
    // This will happen in the Allocator contract...
    const signedHashes: { r: string; s: string; v: number }[] = []
    transaction.inputs.forEach((input, i) => {
      // Verify that the hashes match what bitcoinjs would generate
      const hashToSign = Buffer.from(hashes[i].slice(2), 'hex')

      // Verify that the hashToSign matches what bitcoinjs would generate (sighash)
      const sighash = tx.hashForSignature(
        i,
        Buffer.from(input.script.slice(2), 'hex'),
        bitcoin.Transaction.SIGHASH_ALL
      )
      if (sighash.toString('hex') !== hashToSign.toString('hex')) {
        console.error(`❌ Hash mismatch for input ${i}!`)
        console.error(`Expected: ${sighash.toString('hex')}`)
        console.error(`Got: ${hashToSign.toString('hex')}`)
        process.exit(1)
      } else {
        console.log(
          `✅ Hash matches for input ${i}: ${sighash.toString('hex')}`
        )
      }

      // actually sign!
      const privKey = Buffer.from(allocator.privateKey!, 'hex') // 32 bytes
      const { signature: sig64, recid } = secp.ecdsaSign(hashToSign, privKey)
      const r = Buffer.from(sig64.slice(0, 32)).toString('hex').toUpperCase()
      const s = Buffer.from(sig64.slice(32, 64)).toString('hex').toUpperCase()
      const v = recid // recovery ID (0,1,2 or 3)
      signedHashes[i] = { r, s, v }
    })

    // Add signed inputs to the transaction
    await addSignedInputsToTransaction(tx, hashes, signedHashes)
    await broadcastTransaction(tx)
  }
)
