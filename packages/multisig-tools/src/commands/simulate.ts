import type { Command } from "commander"
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
} from "../builders/utils"

export function registerSimulate(program: Command) {
  program
    .command("simulate")
    .description(
      "Simulate every transaction in a manifest file by building it and printing the hash(es) to sign."
    )
    .requiredOption(
      "-t, --transactions <path>",
      "Path to the transactions manifest JSON file"
    )
    .action(async ({ transactions: transactionsPath }) => {
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
            `Unsupported transaction family: ${(tx as any).family}.`
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
}
