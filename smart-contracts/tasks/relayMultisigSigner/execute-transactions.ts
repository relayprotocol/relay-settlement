import { task } from "hardhat/config"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import {
  createPublicClient,
  parseSignature,
  http,
  recoverAddress,
  serializeTransaction,
} from "viem"
import { checkAndApproveWNEAR } from "../../lib/aurora"
import {
  BitcoinTxSchema,
  buildBitcoinTransaction,
  buildEvmTransaction,
  buildSolanaTransaction,
  getSignatureForHash,
  hasBitcoinTransactionBeenExecuted,
  hasEvmTransactionBeenExecuted,
  loadTransactions,
  type Transaction,
} from "./utils"
import {
  addSignedInputsToTransaction,
  broadcastTransaction,
  buildBitcoinTransactionFromPayload,
} from "../../lib/bitcoin"

import { derivePublicKey } from "../../lib/near"
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
import { PublicKey, Keypair, Connection } from "@solana/web3.js"

async function executeEvmTransaction(
  tx: Extract<Transaction, { family: "ethereum-vm" }>,
  relayMultisigSigner: string,
  hre: HardhatRuntimeEnvironment
) {
  const alreadyExecuted = await hasEvmTransactionBeenExecuted(tx)
  if (alreadyExecuted) {
    console.log("✅ Transaction was already executed, skipping...")
    return
  }

  const {
    transaction,
    hashesToSign: [hashToSign],
  } = await buildEvmTransaction(tx)

  const hexSignature = await getSignatureForHash(
    relayMultisigSigner,
    hashToSign,
    "Ecdsa",
    hre
  )

  // Verify signature matches expected sender
  const signer = await recoverAddress({
    hash: hashToSign,
    signature: hexSignature,
  })
  if (signer.toLowerCase() !== transaction.from.toLowerCase()) {
    throw new Error(
      `❌ Signer does not match transaction sender... Got ${signer}`
    )
  }

  const serializedTransaction = serializeTransaction(
    transaction,
    parseSignature(hexSignature)
  )

  const networkClient = createPublicClient({
    transport: http(tx.rpc),
  })

  const hash = await networkClient.sendRawTransaction({
    serializedTransaction,
  })
  console.log(`🚀 Transaction sent via ${tx.rpc}: ${hash}`)

  const receipt = await networkClient.waitForTransactionReceipt({ hash })
  console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)
}

async function executeBitcoinTransaction(
  tx: Extract<Transaction, { family: "bitcoin-vm" }>,
  relayMultisigSigner: string,
  hre: HardhatRuntimeEnvironment
) {
  const parsedTx = BitcoinTxSchema.parse(tx)

  const alreadyExecuted = await hasBitcoinTransactionBeenExecuted(parsedTx)
  if (alreadyExecuted) {
    console.log("✅ Transaction was already executed, skipping...")
    return
  }

  const result = await buildBitcoinTransaction(parsedTx)

  // Get signatures for all input hashes
  const signedHashes = []
  for (let j = 0; j < result.hashesToSign.length; j++) {
    const hashToSign = result.hashesToSign[j]
    console.log(`🔏 Getting signature for input ${j}: ${hashToSign}`)

    const hexSignature = await getSignatureForHash(
      relayMultisigSigner,
      hashToSign,
      "Ecdsa",
      hre
    )

    const { r, s, v } = parseSignature(hexSignature)
    signedHashes.push({
      r: r.slice(2),
      s: s.slice(2),
      v,
    })
  }

  // Build and sign the transaction
  const builtTx = buildBitcoinTransactionFromPayload(result.transaction)

  await addSignedInputsToTransaction(
    builtTx,
    result.hashesToSign,
    signedHashes,
    result.transaction
  )

  // Broadcast the transaction
  const txid = await broadcastTransaction(builtTx)
  console.log(`✅ Bitcoin transaction confirmed: ${txid}`)
}

export async function executeSolanaTransaction(
  tx: Extract<Transaction, { family: "solana-vm" }>,
  relayMultisigSigner: string,
  hre: HardhatRuntimeEnvironment
) {
  const {
    transaction,
    hashesToSign: [hashToSign],
  } = await buildSolanaTransaction(tx)

  if (!transaction) {
    throw new Error("Failed to build Solana transaction")
  }

  const hexSignature = await getSignatureForHash(
    relayMultisigSigner,
    hashToSign,
    "Eddsa",
    hre,
    true
  )

  // Ok so now we have the signature AND the payload! We can submit!

  // Convert the signature array to Uint8Array
  const signatureBytes = new Uint8Array(
    Buffer.from(hexSignature.slice(2), "hex")
  )

  const derivationPath = relayMultisigSigner.toLowerCase()
  // remove 0x for aurora address
  const predecessor = `${relayMultisigSigner.substring(2).toLowerCase()}.aurora`
  const domainId = 1

  // Get the public key from the NEAR contract
  const { publicKey } = await derivePublicKey(
    derivationPath,
    predecessor,
    Number(domainId)
  )
  const feePayer = new PublicKey(bs58.decode(publicKey))

  transaction.addSignature(feePayer, signatureBytes)

  if (feePayer.toBase58() !== tx.from) {
    throw new Error(
      `❌ Signer does not match transaction sender... Got ${feePayer.toBase58()}`
    )
  }

  // If using Durable Nonce, we need the nonce account authority to sign the nonceAdvance instruction
  if (tx.nonceAccount && tx.nonceAccountAuth) {
    console.log(
      `🔑 Adding nonce authority signature for nonce account: ${tx.nonceAccount}`
    )

    // Read nonce authority private key from environment variable
    const nonceAuthorityPrivateKey =
      process.env.SOLANA_NONCE_AUTHORITY_PRIVATE_KEY
    if (!nonceAuthorityPrivateKey) {
      throw new Error(
        "❌ Durable Nonce transaction requires SOLANA_NONCE_AUTHORITY_PRIVATE_KEY environment variable to be set"
      )
    }

    // Parse and add nonce authority signature
    const nonceAuthorityKeypair = Keypair.fromSecretKey(
      bs58.decode(nonceAuthorityPrivateKey)
    )

    // Verify nonce authority matches
    if (nonceAuthorityKeypair.publicKey.toBase58() !== tx.nonceAccountAuth) {
      throw new Error(
        `❌ Nonce authority private key does not match nonceAccountAuth. Expected: ${tx.nonceAccountAuth}, Got: ${nonceAuthorityKeypair.publicKey.toBase58()}`
      )
    }

    // Sign the transaction with nonce authority
    transaction.sign([nonceAuthorityKeypair])

    console.log("✅ Nonce authority signature added")
  }

  const serializedTransaction = transaction.serialize()
  const signature = bs58.encode(transaction.signatures[0])
  const connection = new Connection(tx.rpc, "confirmed")

  await connection.sendRawTransaction(serializedTransaction, {
    maxRetries: 0,
  })

  console.log(`🚀 Transaction sent via ${tx.rpc}: ${signature}`)

  // Durable Nonce transactions use signature-based confirmation
  await connection.confirmTransaction(signature, "confirmed")

  console.log(`✅ Transaction confirmed: ${signature}`)
}

function countRequiredSignatures(transactions: Transaction[]): number {
  return transactions.reduce((count, tx) => {
    if (tx.family === "bitcoin-vm") {
      return count + tx.inputs.length
    }
    return count + 1
  }, 0)
}

task(
  "relay-multisig-signer:execute-transactions",
  "Executes transactions from a manifest file, signing them via the relay multisig signer"
)
  .addParam("transactions", "The path to the transactions manifest file")
  .addParam("relayMultisigSigner", "address of the relay multisig signer")
  .setAction(
    async ({ transactions: transactionsPath, relayMultisigSigner }, hre) => {
      const [user] = await hre.viem.getWalletClients()
      const transactions = loadTransactions(transactionsPath)

      // We need 1 yocto Near for each signature (Bitcoin needs one per input)
      const signatureCount = countRequiredSignatures(transactions)
      await checkAndApproveWNEAR(
        hre,
        user.account.address,
        relayMultisigSigner,
        BigInt(signatureCount)
      )

      for (let i = 0; i < transactions.length; i++) {
        console.log(`🏗️  Building transaction #${i}`)
        const tx = transactions[i]

        if (tx.family === "ethereum-vm") {
          await executeEvmTransaction(tx, relayMultisigSigner, hre)
        } else if (tx.family === "bitcoin-vm") {
          await executeBitcoinTransaction(tx, relayMultisigSigner, hre)
        } else if (tx.family === "solana-vm") {
          await executeSolanaTransaction(tx, relayMultisigSigner, hre)
        } else {
          throw new Error(
            `Unsupported transaction family: ${tx.family}. Please add support!`
          )
        }
      }
    }
  )
