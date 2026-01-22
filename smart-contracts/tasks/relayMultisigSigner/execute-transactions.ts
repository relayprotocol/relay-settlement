import { task } from "hardhat/config"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import {
  createPublicClient,
  createWalletClient,
  parseSignature,
  http,
  recoverAddress,
  serializeTransaction,
  formatEther,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { networks } from "@relay-protocol/settlement-networks"
import { checkAndApproveWNEAR } from "../../lib/aurora"
import {
  BitcoinTxSchema,
  buildBitcoinTransaction,
  buildEvmTransaction,
  buildSolanaTransaction,
  buildTronTransaction,
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
import * as tronweb from "tronweb"

async function ensureFunding(
  tx: Extract<Transaction, { family: "ethereum-vm" }>
) {
  const networkClient = createPublicClient({
    transport: http(tx.rpc),
  })

  // Get the chain ID from the RPC
  const destinationChainId = await networkClient.getChainId()

  // Check current balance of the from address
  const currentBalance = await networkClient.getBalance({
    address: tx.from as `0x${string}`,
  })

  // Estimate required gas cost
  const gasLimit = BigInt(tx.gas)
  const gasPrice = tx.maxFeePerGas
    ? BigInt(tx.maxFeePerGas)
    : tx.gasPrice
      ? BigInt(tx.gasPrice)
      : await networkClient.getGasPrice()

  const estimatedGasCost = gasLimit * gasPrice
  // Add 50% buffer for safety
  const requiredAmount = (estimatedGasCost * 150n) / 100n

  const shortfall = requiredAmount - currentBalance

  // Relay has minimum bridge amounts, so ensure we're bridging at least $0.50 worth
  // Using 0.0005 ETH (~$1.25) to cover minimum + fees
  const minimumBridgeAmount = BigInt("500000000000000") // 0.0005 ETH
  const amountToBridge =
    shortfall > minimumBridgeAmount ? shortfall : minimumBridgeAmount

  console.log(
    `💰 Need to fund ${tx.from} with ${formatEther(amountToBridge)} native tokens`
  )
  console.log(
    `   Current: ${formatEther(currentBalance)}, Required: ${formatEther(requiredAmount)}, Bridging: ${formatEther(amountToBridge)}`
  )

  // Get deployer private key from environment
  const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY
  if (!deployerPrivateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY environment variable not set")
  }

  // Ensure private key has 0x prefix
  const formattedPrivateKey = deployerPrivateKey.startsWith("0x")
    ? deployerPrivateKey
    : `0x${deployerPrivateKey}`

  const deployerAccount = privateKeyToAccount(
    formattedPrivateKey as `0x${string}`
  )
  const deployerAddress = deployerAccount.address

  // Try to find a suitable source chain for funding
  // Priority: Base > Arbitrum > Optimism > Ethereum
  const preferredSourceChains = [
    8453, // Base
    42161, // Arbitrum
    10, // Optimism
    1, // Ethereum
  ]

  let sourceChainId: number | undefined
  let sourceChainConfig: (typeof networks)[string] | undefined

  for (const chainId of preferredSourceChains) {
    const config = networks[chainId.toString()]
    if (config && config.rpc && config.rpc.length > 0) {
      sourceChainId = chainId
      sourceChainConfig = config
      break
    }
  }

  if (!sourceChainId || !sourceChainConfig) {
    throw new Error(
      `No suitable source chain found for bridging. Tried: ${preferredSourceChains.join(", ")}`
    )
  }

  const destChainName =
    networks[destinationChainId.toString()]?.name ||
    `chain ${destinationChainId}`
  console.log(
    `🌉 Using Relay to bridge from ${sourceChainConfig.name} to ${destChainName}`
  )

  // Get quote from Relay API
  // CRITICAL: Only allow swaps on destination, never on origin (deposit side)
  // This prevents complex multi-step transactions that can fail despite passing simulation
  const quoteResponse = await fetch("https://api.relay.link/quote", {
    body: JSON.stringify({
      amount: amountToBridge.toString(),

      destinationChainId: destinationChainId,

      // Native token on destination
      destinationCurrency: "0x0000000000000000000000000000000000000000",

      // Disable swaps on origin chain - only swap on destination if needed
      options: {
        swapOnOrigin: false,
      },

      originChainId: sourceChainId,
      // Native token on origin - MUST be native, no swaps on deposit
      originCurrency: "0x0000000000000000000000000000000000000000",
      recipient: tx.from,

      referrer: "relay.settlement",

      tradeType: "EXACT_INPUT",

      user: deployerAddress,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  })

  if (!quoteResponse.ok) {
    const errorText = await quoteResponse.text()
    throw new Error(
      `Failed to get Relay quote: ${quoteResponse.status} ${errorText}`
    )
  }

  const quote = await quoteResponse.json()

  // Log the quote structure for debugging
  if (
    !quote.steps ||
    !quote.steps[0] ||
    !quote.steps[0].items ||
    !quote.steps[0].items[0]
  ) {
    console.error("Unexpected quote structure:", JSON.stringify(quote, null, 2))
    throw new Error("Invalid quote response from Relay API")
  }

  const totalFees =
    quote.fees?.relayer?.amount || quote.details?.totalFees?.amount || "0"
  console.log(`   Bridge quote received (fees: ${formatEther(totalFees)})`)

  // Create a wallet client connected to the source chain
  const sourceWalletClient = createWalletClient({
    account: deployerAccount,
    chain: {
      id: sourceChainId,
      name: sourceChainConfig.name,
      nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
      rpcUrls: {
        default: { http: [sourceChainConfig.rpc[0]] },
        public: { http: [sourceChainConfig.rpc[0]] },
      },
    },
    transport: http(sourceChainConfig.rpc[0]),
  })

  const sourceClient = createPublicClient({
    transport: http(sourceChainConfig.rpc[0]),
  })

  const txData = quote.steps[0].items[0].data
  if (!txData || !txData.to || !txData.data) {
    console.error(
      "Invalid transaction data:",
      JSON.stringify(quote.steps[0].items[0], null, 2)
    )
    throw new Error("Invalid transaction data in quote response")
  }

  // CRITICAL: Simulate Relay deposit BEFORE broadcasting
  // This prevents costly failures on L2s where L1 data fees can be 0.05-0.2 ETH
  console.log("🔍 Simulating Relay deposit before sending...")
  try {
    await sourceClient.call({
      account: deployerAddress,
      data: txData.data as `0x${string}`,
      to: txData.to as `0x${string}`,
      value: BigInt(txData.value || "0"),
    })
    console.log("✅ Relay deposit simulation successful")
  } catch (simulationError: any) {
    const errorMsg = simulationError.message || simulationError.toString()
    throw new Error(
      `❌ Relay deposit simulation failed - would have reverted on-chain. Skipping to avoid expensive failure.\nError: ${errorMsg}`
    )
  }

  console.log(`🚀 Sending bridge transaction on ${sourceChainConfig.name}...`)

  const bridgeHash = await sourceWalletClient.sendTransaction({
    data: txData.data as `0x${string}`,
    to: txData.to as `0x${string}`,
    value: BigInt(txData.value || "0"),
  })

  console.log(`   Bridge tx: ${bridgeHash}`)
  await sourceClient.waitForTransactionReceipt({ hash: bridgeHash })

  // Get deployer's balance on source chain before waiting (to detect refunds)
  const deployerBalanceBeforeBridge = await sourceClient.getBalance({
    address: deployerAddress,
  })

  // Wait for bridge completion by polling destination balance and checking Relay status
  console.log("⏳ Waiting for bridge to complete...")
  let attempts = 0
  const maxAttempts = 60 // 5 minutes with 5 second intervals
  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 5000))

    // Check balance on destination
    const newBalance = await networkClient.getBalance({
      address: tx.from as `0x${string}`,
      blockTag: "latest", // Force latest block, not cached
    })

    // Check if balance increased from initial balance
    if (newBalance > currentBalance) {
      console.log(
        `✅ Funding complete! New balance: ${formatEther(newBalance)} (was: ${formatEther(currentBalance)})`
      )
      return
    }

    // Every 30 seconds, check Relay status and deployer balance to detect refunds
    if (attempts > 0 && attempts % 6 === 0) {
      // Check if funds were refunded back to deployer on source chain
      const deployerBalanceNow = await sourceClient.getBalance({
        address: deployerAddress,
      })
      const expectedBalanceIfRefunded =
        deployerBalanceBeforeBridge +
        BigInt(txData.value || "0") -
        BigInt("100000000000000") // Allow for gas costs

      if (deployerBalanceNow > expectedBalanceIfRefunded) {
        throw new Error(
          `Bridge appears to have been refunded - deployer balance on ${sourceChainConfig.name} increased unexpectedly`
        )
      }

      try {
        const statusResponse = await fetch(
          `https://api.relay.link/requests/status?hash=${bridgeHash}`
        )
        if (statusResponse.ok) {
          const status = await statusResponse.json()
          if (status.status === "refunded" || status.status === "failed") {
            throw new Error(
              `Bridge was ${status.status}. Reason: ${status.inTxs?.[0]?.statusReason || "Unknown"}`
            )
          }
          console.log(
            `   Still waiting... (${attempts * 5}s elapsed) - Balance: ${formatEther(newBalance)}, Status: ${status.status || "unknown"}`
          )
        } else {
          console.log(
            `   Still waiting... (${attempts * 5}s elapsed) - Balance: ${formatEther(newBalance)}`
          )
        }
      } catch (error: any) {
        // If the error is about refund/failure, rethrow it
        if (
          error.message?.includes("refunded") ||
          error.message?.includes("failed")
        ) {
          throw error
        }
        // Otherwise just log and continue
        console.log(
          `   Still waiting... (${attempts * 5}s elapsed) - Balance: ${formatEther(newBalance)}`
        )
      }
    }

    attempts++
  }

  throw new Error("Bridge timeout - funds did not arrive within 5 minutes")
}

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

  // Proactively check balance before broadcasting to avoid silent rejections
  const currentBalance = await networkClient.getBalance({
    address: transaction.from as `0x${string}`,
  })

  const gasLimit = BigInt(transaction.gas || 0)
  const gasPrice = transaction.maxFeePerGas
    ? BigInt(transaction.maxFeePerGas)
    : transaction.gasPrice
      ? BigInt(transaction.gasPrice)
      : await networkClient.getGasPrice()

  const estimatedGasCost = gasLimit * gasPrice
  const txValue = transaction.value ? BigInt(transaction.value) : 0n
  const requiredBalance = estimatedGasCost + txValue

  if (currentBalance < requiredBalance) {
    console.log(
      `⚠️  Insufficient balance detected before broadcast. Current: ${formatEther(currentBalance)}, Required: ${formatEther(requiredBalance)}`
    )
    await ensureFunding(tx)

    // Recheck balance after funding
    const newBalance = await networkClient.getBalance({
      address: transaction.from as `0x${string}`,
    })
    if (newBalance < requiredBalance) {
      throw new Error(
        `Insufficient funds after funding attempt. Have: ${formatEther(newBalance)}, Need: ${formatEther(requiredBalance)}`
      )
    }
    console.log(
      `✅ Funding successful, new balance: ${formatEther(newBalance)}`
    )
  }

  try {
    const hash = await networkClient.sendRawTransaction({
      serializedTransaction,
    })
    console.log(`🚀 Transaction sent via ${tx.rpc}: ${hash}`)

    const receipt = await networkClient.waitForTransactionReceipt({ hash })
    console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)
  } catch (error: any) {
    // Check if error is due to insufficient funds
    const errorMessage = error.message?.toLowerCase() || ""
    if (
      errorMessage.includes("insufficient funds") ||
      errorMessage.includes("insufficient balance") ||
      errorMessage.includes("gas * price + value")
    ) {
      console.log(
        "⚠️  Insufficient funds error during broadcast, attempting to fund address..."
      )
      await ensureFunding(tx)

      // Retry the transaction
      const hash = await networkClient.sendRawTransaction({
        serializedTransaction,
      })
      console.log(`🚀 Transaction sent via ${tx.rpc}: ${hash}`)

      const receipt = await networkClient.waitForTransactionReceipt({ hash })
      console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)
    } else {
      throw error
    }
  }
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

export async function executeTronTransaction(
  tx: Extract<Transaction, { family: "tron-vm" }>,
  relayMultisigSigner: string,
  hre: HardhatRuntimeEnvironment
) {
  const {
    transaction,
    hashesToSign: [hashToSign],
  } = await buildTronTransaction(tx)

  // Get signature from RelayMultisigSigner using Ecdsa
  const hexSignature = await getSignatureForHash(
    relayMultisigSigner,
    hashToSign,
    "Ecdsa",
    hre
  )

  const tronSignature = hexSignature.slice(2).toLowerCase()

  // Add signature to transaction
  if (Array.isArray(transaction.signature)) {
    if (!transaction.signature.includes(tronSignature)) {
      transaction.signature.push(tronSignature)
    }
  } else {
    transaction.signature = [tronSignature]
  }

  // Broadcast transaction
  const tronWeb = new tronweb.TronWeb({
    fullHost: tx.rpc,
    fullNode: new tronweb.providers.HttpProvider(tx.rpc),
  })

  console.log(`🚀 Broadcasting Tron transaction: ${transaction.txID}`)

  const result = await tronWeb.trx.sendRawTransaction(transaction)
  if (!result.result) {
    console.log(JSON.stringify(result, null, 2))
    throw new Error(
      `❌ Transaction broadcast failed: ${result.code || "Unknown error"}`
    )
  }

  console.log(`🚀 Transaction sent via ${tx.rpc}: ${transaction.txID}`)

  // Wait for confirmation (similar to Ethereum's waitForTransactionReceipt)
  const startTime = Date.now()
  const timeout = 60000 // 60 seconds

  let receipt: any
  while (!receipt || !Object.keys(receipt).length) {
    // Check timeout
    if (Date.now() - startTime > timeout) {
      throw new Error(
        `Transaction check timed out after ${timeout / 1000} seconds`
      )
    }

    try {
      receipt = await tronWeb.trx.getUnconfirmedTransactionInfo(
        transaction.txID
      )
    } catch {
      // Skip errors
    }

    // Check if transaction reverted
    if (
      receipt &&
      receipt.receipt?.result &&
      receipt.receipt.result !== "SUCCESS"
    ) {
      throw new Error(`Transaction reverted: ${receipt.receipt.result}`)
    }

    // Wait if not confirmed yet
    if (!receipt || !Object.keys(receipt).length || !receipt.receipt?.result) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  console.log(`✅ Transaction confirmed: ${transaction.txID}`)
  if (receipt.receipt?.result === "SUCCESS") {
    console.log("✅ Transaction executed successfully")
  }
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
  .addOptionalParam(
    "relayMultisigSigner",
    "address of the relay multisig signer (defaults to network config)"
  )
  .setAction(
    async (
      {
        transactions: transactionsPath,
        relayMultisigSigner: relayMultisigSignerAddress,
      },
      hre
    ) => {
      const [user] = await hre.viem.getWalletClients()

      // Get the relay multisig signer address from network config if not provided
      let relayMultisigSigner = relayMultisigSignerAddress
      if (!relayMultisigSigner) {
        const chainId = hre.network.config.chainId
        if (!chainId) {
          throw new Error("Chain ID not found in network config")
        }
        const network = networks[chainId.toString()]
        if (!network?.contracts?.prod?.multisigSigner) {
          throw new Error(
            `No multisigSigner address found in network config for chain ${chainId}`
          )
        }
        relayMultisigSigner = network.contracts.prod.multisigSigner
        console.log(
          `Using multisigSigner address from network config: ${relayMultisigSigner}`
        )
      }

      const transactions = loadTransactions(transactionsPath)

      // We need 1 yocto Near for each signature (Bitcoin needs one per input)
      const signatureCount = countRequiredSignatures(transactions)
      await checkAndApproveWNEAR(
        hre,
        user.account.address,
        relayMultisigSigner,
        BigInt(signatureCount)
      )

      const failures: Array<{ index: number; tx: Transaction; error: string }> =
        []

      for (let i = 0; i < transactions.length; i++) {
        console.log(`🏗️  Building transaction #${i}`)
        const tx = transactions[i]

        try {
          if (tx.family === "ethereum-vm") {
            await executeEvmTransaction(tx, relayMultisigSigner, hre)
          } else if (tx.family === "bitcoin-vm") {
            await executeBitcoinTransaction(tx, relayMultisigSigner, hre)
          } else if (tx.family === "solana-vm") {
            await executeSolanaTransaction(tx, relayMultisigSigner, hre)
          } else if (tx.family === "tron-vm") {
            await executeTronTransaction(tx, relayMultisigSigner, hre)
          } else {
            throw new Error(
              `Unsupported transaction family: ${tx.family}. Please add support!`
            )
          }
        } catch (error: any) {
          const errorMsg = error.message || error.toString() || "Unknown error"
          console.error(`❌ Transaction #${i} failed: ${errorMsg}`)
          failures.push({
            error: errorMsg,
            index: i,
            tx,
          })
          // Continue to next transaction
        }
      }

      // Report summary
      console.log(`\n${"=".repeat(80)}`)
      console.log(
        `\n✅ Successfully executed ${transactions.length - failures.length}/${transactions.length} transactions`
      )

      if (failures.length > 0) {
        console.log(`\n❌ Failed transactions (${failures.length}):`)
        for (const failure of failures) {
          const txInfo =
            failure.tx.family === "ethereum-vm"
              ? `${failure.tx.to} on chain ${failure.tx.rpc}`
              : `${failure.tx.family} transaction`
          console.log(`  [${failure.index}] ${txInfo}`)
          console.log(`      Error: ${failure.error}`)
        }
        console.log(
          "\nTo retry failed transactions, re-run the same command. Already executed transactions will be skipped."
        )
      }
    }
  )
