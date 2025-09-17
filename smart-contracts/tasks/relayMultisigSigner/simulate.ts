import { task } from 'hardhat/config'
import { keccak256, serializeTransaction } from 'viem'
import { buildEvmTransaction, loadTransactions } from './utils'

task(
  'relay-multisig-signer:simulate',
  'Simulates transactions from a transactions manifest file.'
)
  .addParam('transactions', 'The path to the transactions manifest file')
  .setAction(async ({ transactions: transactionsPath }) => {
    // load json file from transactionsPath using node's interface
    const transactions = loadTransactions(transactionsPath)

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i]
      if (tx.family === 'ethereum-vm') {
        const transaction = await buildEvmTransaction(tx)
        if (transaction) {
          const rawUnsigned = serializeTransaction(transaction) // EVM
          console.log('✅ Successful transaction:', tx)
          console.log(`📦 Payload: ${rawUnsigned}`)
          const hashToSign = keccak256(rawUnsigned)
          console.log(`📝 Hash to sign: ${hashToSign}\n`)
        }
      } else {
        throw new Error(
          `Unsupported transaction family: ${tx.family}. Please add support!`
        )
      }
    }
  })
