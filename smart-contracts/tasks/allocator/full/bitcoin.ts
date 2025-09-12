import { task } from 'hardhat/config'
import * as bitcoin from 'bitcoinjs-lib'

import { decodeAbiParameters, encodeAbiParameters, zeroAddress } from 'viem'
import {
  addSignedInputsToTransaction,
  BITCOIN_TRANSACTION_ABI,
  BITCOIN_TRANSACTION_PARAMS_ABI,
  bitcoinAddressfromHexPublicKey,
  broadcastTransaction,
  buildBitcoinTransactionFromPayload,
  estimateFeeRate,
  fetchUtxo,
  getBalance,
  txidToBytes32,
} from '../../../lib/bitcoin'
import { extractNearSignature } from '../../../lib/near'
import { wait } from '../../../lib/wait'

task(
  'full:bitcoin',
  'Deploy the Allocator contract, initializes it, sets a payload builder, submits a withdraw request, triggers a signature, and verifies the payload'
)
  .addOptionalParam('owner', 'The address of the owner')
  .addOptionalParam('depository', 'The address of the depository EOA')
  .addOptionalParam('signer', 'The address of the signer')
  .addOptionalParam('wnear', 'The address of the wNEAR token, used to pay fees')
  .addOptionalParam(
    'amount',
    'The amount to withdraw from the depository',
    '1000'
  )
  .addParam(
    'publicKey',
    'The public key of the signer (ethereum format: 0x...)'
  )
  .addParam('recipient', 'The Bitcoin address to send the funds to')
  .setAction(
    async (
      { owner, signer, wnear, amount, recipient, publicKey },
      { viem, run }
    ) => {
      // recompile contracts
      await run('compile')

      // A fake chainId for Bitcoin, since we don't have a real one in the testnet
      const bitcoinChainId = 817781938n

      const publicClient = await viem.getPublicClient()

      const allocatorAddress = await run('deploy:allocator', {
        owner,
        signer,
        wnear,
      })

      const allocator = await viem.getContractAt('Allocator', allocatorAddress)
      const delay = await allocator.read.delay()

      await run('allocator:grant-hub-role', {
        account: owner,
        allocator: allocatorAddress,
      })

      let bitcoinPayloadBuilderAddress = await allocator.read.payloadBuilders([
        bitcoinChainId,
        zeroAddress, // No depository contract for Bitcoin
      ])
      if (bitcoinPayloadBuilderAddress === zeroAddress) {
        console.log('Bitcoin PayloadBuilder not set, deploying a new one...')

        bitcoinPayloadBuilderAddress = await run(
          'deploy:bitcoin-payload-builder',
          {
            allocatorPublicKey: publicKey,
          }
        )

        const tx = await allocator.write.setPayloadBuilder([
          bitcoinChainId,
          zeroAddress,
          bitcoinPayloadBuilderAddress,
        ])
        await publicClient.waitForTransactionReceipt({
          hash: tx,
        })
      }

      // Let's now submit a withdraw request to the Bitcoin PayloadBuilder
      const depositoryAddress = bitcoinAddressfromHexPublicKey(publicKey)

      const btcBalance = await getBalance(depositoryAddress)
      console.log(
        `BTC Balance (${depositoryAddress}): ${btcBalance.btc} BTC, ${btcBalance.satoshis} satoshis`
      )

      const feeRate = await estimateFeeRate()
      const utxos = await fetchUtxo(depositoryAddress!)

      if (utxos.length === 0) {
        throw new Error(
          `No UTXOs found for address ${depositoryAddress}. Please fund the address with some BTC first!`
        )
      }

      const payloadData = encodeAbiParameters(
        [BITCOIN_TRANSACTION_PARAMS_ABI],
        [
          {
            feeRate,
            utxos: utxos.map((utxo) => ({
              index: utxo.vout,
              scriptPubKey: `0x${utxo.scriptPubKey}`,
              txid: txidToBytes32(utxo.txid),
              value: BigInt(utxo.value),
            })),
          },
        ] // data
      )

      const receiverScript = bitcoin.address
        .toOutputScript(recipient, bitcoin.networks.testnet)
        .toString('base64')

      const withdrawRequestHash = await run('allocator:submit-withdraw', {
        allocator: allocatorAddress,
        amount,
        chainId: bitcoinChainId.toString(),
        currency: zeroAddress,
        data: payloadData,
        depository: zeroAddress,
        receiver: receiverScript,
        wnear,
      })

      // Get the payload
      const payload = await allocator.read.unsignedPayloads([
        withdrawRequestHash,
      ])

      // Trigger a signature
      await wait(delay)

      await run('allocator:sign-payload', {
        allocator: allocatorAddress,
        chainId: bitcoinChainId.toString(),
        depository: zeroAddress,
        withdrawRequestHash,
        wnear,
      })

      // ok so now we have a payload (request) and we need to get all the signatures for each hash.
      const payloadBuilder = await viem.getContractAt(
        'BitcoinPayloadBuilder',
        bitcoinPayloadBuilderAddress
      )
      const payloadHashes = await payloadBuilder.read.hashesToSign([
        bitcoinChainId,
        zeroAddress, // No depository contract for Bitcoin
        payload,
      ])

      const signedHashes = []

      for (let i = 0; i < payloadHashes.length; i++) {
        const hash = payloadHashes[i]
        let signature = await allocator.read.signedPayloads([
          withdrawRequestHash,
          hash,
        ])
        while (signature === '0x') {
          console.log('Waiting for signed payload...')
          await wait(1)
          signature = await allocator.read.signedPayloads([
            withdrawRequestHash,
            hash,
          ])
        }
        signedHashes.push(extractNearSignature(signature))
      }

      const [transaction] = decodeAbiParameters(
        BITCOIN_TRANSACTION_ABI,
        payload
      )
      const tx = buildBitcoinTransactionFromPayload(transaction)

      await addSignedInputsToTransaction(tx, payloadHashes, signedHashes)

      // Debug your transaction outputs before broadcasting
      console.log('\n🔍 Transaction outputs:')
      tx.outs.forEach((output, index) => {
        console.log(`Output ${index}:`)
        console.log('  Value:', output.value, 'satoshis')
        console.log('  Script (hex):', output.script.toString('hex'))

        // Try to decode the script
        try {
          const address = bitcoin.address.fromOutputScript(
            output.script,
            bitcoin.networks.bitcoin
          )
          console.log('  Address:', address)
        } catch {
          console.log(
            '  Address: Unable to decode - possibly OP_RETURN or non-standard'
          )
          // Check if it's OP_RETURN
          if (output.script[0] === 0x6a) {
            console.log('  Type: OP_RETURN (data output)')
          }
        }
      })

      // Calculate total "burned" amount
      const burnAmount = tx.outs
        .filter((out) => out.script[0] === 0x6a)
        .reduce((sum, out) => sum + out.value, 0)
      console.log('\nTotal unspendable amount:', burnAmount, 'satoshis')

      await broadcastTransaction(tx)
    }
  )
