import { task } from "hardhat/config"
import {
  BitcoinTxSchema,
  EthereumTxSchema,
  SolanaTxSchema,
  TronTxSchema,
  buildBitcoinTransaction,
  buildSolanaTransaction,
  buildTronTransaction,
  buildEvmTransaction,
  loadTransactions,
} from "./utils"

task(
  "relay-multisig-signer:simulate",
  "Simulates transactions from a transactions manifest file."
)
  .addParam("transactions", "The path to the transactions manifest file")
  .setAction(async ({ transactions: transactionsPath }) => {
    // load json file from transactionsPath using node's interface
    const transactions = loadTransactions(transactionsPath)

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i]
      let result
      if (tx.family === "ethereum-vm") {
        result = await buildEvmTransaction(EthereumTxSchema.parse(tx))
      } else if (tx.family === "bitcoin-vm") {
        result = await buildBitcoinTransaction(BitcoinTxSchema.parse(tx))
      } else if (tx.family === "solana-vm") {
        result = await buildSolanaTransaction(SolanaTxSchema.parse(tx))
      } else if (tx.family === "tron-vm") {
        result = await buildTronTransaction(TronTxSchema.parse(tx))
      } else {
        throw new Error(
          `Unsupported transaction family: ${tx.family}. Please add support!`
        )
      }
      console.log("✅ Successful transaction:", tx)
      console.log(`📦 Payload: ${result.payload}`)
      console.log("📝 Hashes to sign:")
      result.hashesToSign.forEach((hash, index) => {
        console.log(`   [${index}] ${hash}`)
      })
      console.log("")
    }
  })
