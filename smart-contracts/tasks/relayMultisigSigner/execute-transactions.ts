import { task } from "hardhat/config"
import {
  createPublicClient,
  Hex,
  parseSignature,
  http,
  keccak256,
  recoverAddress,
  serializeTransaction,
} from "viem"
import { wait } from "../../lib/wait"
import { checkAndApproveWNEAR } from "../../lib/aurora"
import { extractNearSignature } from "../../lib/near"
import { buildEvmTransaction, loadTransactions } from "./utils"

const signGas = 50_000_000_000_000n
const callbackGas = 30_000_000_000_000n

task(
  "relay-multisig-signer:execute-transactions",
  "Checks transaction hashes from a transactions manifest file against a Gnosis Safe. They must match the transactions from the manifest."
)
  .addParam("transactions", "The path to the transactions manifest file")
  .addParam("relayMultisigSigner", "address of the relay multisig signer")
  .setAction(
    async ({ transactions: transactionsPath, relayMultisigSigner }, hre) => {
      const [user] = await hre.viem.getWalletClients()

      const transactions = loadTransactions(transactionsPath)

      const multisigSigner = await hre.viem.getContractAt(
        "RelayMultisigSigner",
        relayMultisigSigner
      )

      // We need 1 yocto Near for each signature!
      await checkAndApproveWNEAR(
        hre,
        user.account.address,
        relayMultisigSigner,
        BigInt(transactions.length)
      )

      for (let i = 0; i < transactions.length; i++) {
        console.log(`🏗️  Building transaction #${i}`)
        const tx = transactions[i]
        let rawUnsigned
        let curve: "Ecdsa" | "Eddsa"
        if (tx.family === "ethereum-vm") {
          const transaction = await buildEvmTransaction(tx)
          if (!transaction) {
            throw new Error("Failed to build EVM transaction")
          }
          rawUnsigned = serializeTransaction(transaction) // EVM
          curve = "Ecdsa"
          const hashToSign = keccak256(rawUnsigned)

          let nearSignature = await multisigSigner.read.signatures([
            hashToSign,
            curve,
          ])

          if (nearSignature === "0x") {
            // Check if the signature was approved
            const approved = await multisigSigner.read.approvedSignatures([
              hashToSign,
              curve,
            ])
            if (!approved) {
              throw new Error("❌ Signature not approved...")
            }

            console.log("📝 Requesting signature...", { curve, hashToSign })

            const txHash = await multisigSigner.write.sign([
              hashToSign,
              curve,
              signGas,
              callbackGas,
            ])

            const publicClient = await hre.viem.getPublicClient()
            await publicClient.waitForTransactionReceipt({
              hash: txHash,
            })
          }
          while (nearSignature === "0x") {
            console.log("Waiting for signed hash...")
            await wait(1)
            nearSignature = await multisigSigner.read.signatures([
              hashToSign,
              curve,
            ])
          }

          // Ok so now we have the signature AND the payload! We can submit!
          const { r, s, v } = extractNearSignature(nearSignature)
          const hexSignature =
            `0x${r}${s}${v.toString(16).padStart(2, "0")}` as `0x${string}`
          const signer = await recoverAddress({
            hash: hashToSign,
            signature: hexSignature,
          })
          console.log(transaction.from)
          if (signer.toLowerCase() !== transaction.from.toLowerCase()) {
            throw new Error(
              `❌ Signer does not match transaction sender... Got ${signer}`
            )
          }

          const serializedTransaction: Hex = serializeTransaction(
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
          const receipt = await networkClient.waitForTransactionReceipt({
            hash,
          })
          console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)
        } else {
          throw new Error(
            `Unsupported transaction family: ${tx.family}. Please add support!`
          )
        }
      }

      // For each transaction, create the hash, check that it has been approved
      // Trigger the signature
      // Retrieve the signature
      // Execute the transaction!
    }
  )
