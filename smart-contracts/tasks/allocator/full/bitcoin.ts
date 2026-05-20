import { base58 } from "@scure/base"
import { task } from "hardhat/config"
import * as bitcoin from "bitcoinjs-lib"

import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  zeroAddress,
} from "viem"
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
  verifySighashMatches,
} from "@relay-settlement/multisig-tools/crypto/bitcoin"
import { getAllocatorPublicKey } from "@relay-settlement/multisig-tools/crypto/signer"
import { extractNearSignature } from "@relay-settlement/multisig-tools/crypto/near"
import { wait } from "@relay-settlement/multisig-tools/crypto/wait"
import { networks } from "@relay-protocol/settlement-networks"

task(
  "full:bitcoin",
  "Deploy the Allocator contract, initializes it, sets a payload builder, submits a withdraw request, triggers a signature, and verifies the payload"
)
  .addOptionalParam("owner", "The address of the owner")
  .addOptionalParam("depository", "The address of the depository EOA")
  .addOptionalParam("signer", "The address of the signer")
  .addOptionalParam("wnear", "The address of the wNEAR token, used to pay fees")
  .addOptionalParam(
    "amount",
    "The amount to withdraw from the depository",
    "1000"
  )
  .addParam("recipient", "The Bitcoin address to send the funds to")
  .setAction(
    async ({ owner, signer, wnear, amount, recipient }, { viem, run }) => {
      // recompile contracts
      const publicClient = await viem.getPublicClient()

      await run("compile")

      const { near: nearNetwork } = networks[await publicClient.getChainId()]
      const [admin] = await viem.getWalletClients()

      if (!signer) {
        signer = nearNetwork!.signer
      }

      if (!owner) {
        owner = admin.account.address
      }

      // A fake chainId for Bitcoin, since we don't have a real one in the testnet
      const bitcoinChainId = 817781938n

      const allocatorAddress = await run("deploy:allocator", {
        owner,
        signer,
        wnear,
      })

      const allocator = await viem.getContractAt(
        "RelayAllocator",
        allocatorAddress
      )
      const delay = await allocator.read.delay()

      await run("allocator:add-withdrawer", {
        account: owner,
        allocator: allocatorAddress,
      })

      let bitcoinPayloadBuilderAddress = await allocator.read.payloadBuilders([
        bitcoinChainId,
        zeroAddress, // No depository contract for Bitcoin
      ])

      // Get the RAW public key, not the derived address
      const rawPublicKey = await getAllocatorPublicKey(
        publicClient,
        allocatorAddress,
        "bitcoin-vm"
      )

      // Convert to hex format for the PayloadBuilder
      const publicKeyHex = `0x04${Buffer.from(base58.decode(rawPublicKey)).toString("hex")}`

      if (bitcoinPayloadBuilderAddress === zeroAddress) {
        console.log("Bitcoin PayloadBuilder not set, deploying a new one...")

        bitcoinPayloadBuilderAddress = await run(
          "deploy:bitcoin-payload-builder",
          {
            allocatorPublicKey: publicKeyHex,
            bitcoinNetwork: "testnet",
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

      // Generate the correct Bitcoin address from the raw public key
      const depositoryAddress = bitcoinAddressfromHexPublicKey(publicKeyHex)

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
      // Select the smallest number of UTXOs to cover the amount + estimated fee
      let totalInput = 0n
      const targetAmount = BigInt(amount) + BigInt(1000 * feeRate) // rough estimate of fee
      const selectedUtxos = []
      for (const utxo of utxos) {
        selectedUtxos.push(utxo)
        totalInput += BigInt(utxo.value)
        if (totalInput >= targetAmount) {
          break
        }
      }

      const payloadData = encodeAbiParameters(
        [BITCOIN_TRANSACTION_PARAMS_ABI],
        [
          {
            feeRate,
            utxos: selectedUtxos.map((utxo) => ({
              index: utxo.vout,
              scriptPubKey: `0x${utxo.scriptPubKey}`,
              txid: txidToBytes32(utxo.txid),
              value: BigInt(utxo.value),
            })),
          },
        ] // data
      )

      const receiverScript = bitcoin.address
        .toOutputScript(recipient, bitcoin.networks.testnet) // TODO: handle prod?
        .toString("base64")

      const nonce = keccak256(`0x${new Date().getTime().toString()}`)

      const hasRole = await allocator.read.hasRole([
        keccak256("APPROVED_WITHDRAWER_ROLE"),
        owner!,
      ])
      if (!hasRole) {
        throw new Error(`${owner} is not a withdrawer`)
      }

      const withdrawRequestHash = await run("allocator:submit-withdraw", {
        allocator: allocatorAddress,
        amount,
        chainId: bitcoinChainId.toString(),
        currency: zeroAddress,
        data: payloadData,
        depository: zeroAddress,
        nonce,
        receiver: receiverScript,
        wnear,
      })

      // Get the payload
      const payload = await allocator.read.payloads([withdrawRequestHash])

      // Trigger a signature
      await wait(Number(delay))
      const timestamp = await allocator.read.payloadTimestamps([
        withdrawRequestHash,
      ])
      while (new Date().getTime() < Number(timestamp) * 1000) {
        await wait(1)
      }

      await run("allocator:sign-payload", {
        allocator: allocatorAddress,
        amount,
        chainId: bitcoinChainId.toString(),
        currency: zeroAddress,
        data: payloadData,
        depository: zeroAddress,
        nonce,
        receiver: receiverScript,
        wnear,
      })

      // ok so now we have a payload (request) and we need to get all the signatures for each hash.
      const payloadBuilder = await viem.getContractAt(
        "BitcoinPayloadBuilder",
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
        while (signature === "0x") {
          console.log("Waiting for signed payload...")
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

      // Verify SIGHASH generation matches bitcoinjs-lib before signing
      await verifySighashMatches(tx, transaction, payloadHashes)

      await addSignedInputsToTransaction(
        tx,
        payloadHashes,
        signedHashes,
        transaction
      )

      await broadcastTransaction(tx)
    }
  )
