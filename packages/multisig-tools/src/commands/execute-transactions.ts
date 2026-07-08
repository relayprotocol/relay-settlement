import type { Command } from "commander"
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
} from "../builders/utils"
import {
  addSignedInputsToTransaction,
  broadcastTransaction,
  buildBitcoinTransactionFromPayload,
} from "../crypto/bitcoin"
import { derivePublicKey } from "../crypto/near"
import { resolveNetwork, type ResolvedNetwork } from "../helpers/network"
import { checkAndApproveWNEAR } from "../helpers/wnear"
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
import { PublicKey, Keypair, Connection } from "@solana/web3.js"
import * as tronweb from "tronweb"

async function ensureFunding(
  tx: Extract<Transaction, { family: "ethereum-vm" }>
) {
  const networkClient = createPublicClient({ transport: http(tx.rpc) })
  const destinationChainId = await networkClient.getChainId()
  const currentBalance = await networkClient.getBalance({
    address: tx.from,
  })

  const gasLimit = BigInt(tx.gas)
  const gasPrice = tx.maxFeePerGas
    ? BigInt(tx.maxFeePerGas)
    : tx.gasPrice
      ? BigInt(tx.gasPrice)
      : await networkClient.getGasPrice()

  const estimatedGasCost = gasLimit * gasPrice
  const requiredAmount = (estimatedGasCost * 150n) / 100n
  const shortfall = requiredAmount - currentBalance
  const minimumBridgeAmount = BigInt("500000000000000") // 0.0005 ETH
  const amountToBridge =
    shortfall > minimumBridgeAmount ? shortfall : minimumBridgeAmount

  const destinationChainName =
    networks[destinationChainId.toString()]?.name ||
    `chain ${destinationChainId}`

  console.log(
    `💰 Need to fund ${tx.from} with ${formatEther(amountToBridge)} native tokens`
  )
  console.log(
    `   Current: ${formatEther(currentBalance)}, Required: ${formatEther(requiredAmount)}, Amount: ${formatEther(amountToBridge)}`
  )

  const deployerPrivateKey =
    process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY
  if (!deployerPrivateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY environment variable not set")
  }
  const formattedPrivateKey = deployerPrivateKey.startsWith("0x")
    ? deployerPrivateKey
    : `0x${deployerPrivateKey}`
  const deployerAccount = privateKeyToAccount(
    formattedPrivateKey as `0x${string}`
  )
  const deployerAddress = deployerAccount.address

  // If the deployer already holds enough native funds on the destination chain,
  // fund the target with a basic transfer instead of bridging via Relay.
  const deployerBalance = await networkClient.getBalance({
    address: deployerAddress,
  })
  // Keep headroom for the funding transaction's own gas.
  if (deployerBalance >= amountToBridge + estimatedGasCost) {
    console.log(
      `💸 Deployer has sufficient funds on ${destinationChainName}; sending a direct transfer`
    )
    const directWalletClient = createWalletClient({
      account: deployerAccount,
      chain: {
        id: destinationChainId,
        name: destinationChainName,
        nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
        rpcUrls: {
          default: { http: [tx.rpc] },
          public: { http: [tx.rpc] },
        },
      },
      transport: http(tx.rpc),
    })

    const transferHash = await directWalletClient.sendTransaction({
      to: tx.from,
      value: amountToBridge,
    })
    console.log(`   Transfer tx: ${transferHash}`)
    await networkClient.waitForTransactionReceipt({ hash: transferHash })

    const newBalance = await networkClient.getBalance({ address: tx.from })
    console.log(
      `✅ Funding complete via direct transfer! New balance: ${formatEther(newBalance)}`
    )
    return
  }

  console.log(
    `🤵 Deployer lacks funds on ${destinationChainName}; bridging via Relay instead`
  )

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

  console.log(
    `🌉 Using Relay to bridge from ${sourceChainConfig.name} to ${destinationChainName}`
  )

  const quoteResponse = await fetch("https://api.relay.link/quote", {
    body: JSON.stringify({
      amount: amountToBridge.toString(),
      destinationChainId,
      destinationCurrency: "0x0000000000000000000000000000000000000000",
      options: { swapOnOrigin: false },
      originChainId: sourceChainId,
      originCurrency: "0x0000000000000000000000000000000000000000",
      recipient: tx.from,
      referrer: "relay.settlement",
      tradeType: "EXACT_INPUT",
      user: deployerAddress,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  })

  if (!quoteResponse.ok) {
    const errorText = await quoteResponse.text()
    throw new Error(
      `Failed to get Relay quote: ${quoteResponse.status} ${errorText}`
    )
  }

  const quote = (await quoteResponse.json()) as any

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

  const deployerBalanceBeforeBridge = await sourceClient.getBalance({
    address: deployerAddress,
  })

  console.log("⏳ Waiting for bridge to complete...")
  let attempts = 0
  const maxAttempts = 60
  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 5000))

    const newBalance = await networkClient.getBalance({
      address: tx.from,
      blockTag: "latest",
    })

    if (newBalance > currentBalance) {
      console.log(
        `✅ Funding complete! New balance: ${formatEther(newBalance)} (was: ${formatEther(currentBalance)})`
      )
      return
    }

    if (attempts > 0 && attempts % 6 === 0) {
      const deployerBalanceNow = await sourceClient.getBalance({
        address: deployerAddress,
      })
      const expectedBalanceIfRefunded =
        deployerBalanceBeforeBridge +
        BigInt(txData.value || "0") -
        BigInt("100000000000000")

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
          const status = (await statusResponse.json()) as any
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
        if (
          error.message?.includes("refunded") ||
          error.message?.includes("failed")
        ) {
          throw error
        }
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
  relayMultisigSigner: `0x${string}`,
  resolved: ResolvedNetwork
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
    {
      publicClient: resolved.publicClient,
      walletClient: resolved.walletClient,
    }
  )

  const signer = await recoverAddress({
    hash: hashToSign,
    signature: hexSignature as `0x${string}`,
  })
  if (signer.toLowerCase() !== transaction.from.toLowerCase()) {
    throw new Error(
      `❌ Signer does not match transaction sender... Got ${signer}`
    )
  }

  const serializedTransaction = serializeTransaction(
    transaction as any,
    parseSignature(hexSignature as `0x${string}`)
  )

  const networkClient = createPublicClient({ transport: http(tx.rpc) })

  const currentBalance = await networkClient.getBalance({
    address: transaction.from,
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

    const newBalance = await networkClient.getBalance({
      address: transaction.from,
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
  relayMultisigSigner: `0x${string}`,
  resolved: ResolvedNetwork
) {
  const parsedTx = BitcoinTxSchema.parse(tx)

  const alreadyExecuted = await hasBitcoinTransactionBeenExecuted(parsedTx)
  if (alreadyExecuted) {
    console.log("✅ Transaction was already executed, skipping...")
    return
  }

  const result = await buildBitcoinTransaction(parsedTx)

  const signedHashes: Array<{ r: string; s: string; v: number }> = []
  for (let j = 0; j < result.hashesToSign.length; j++) {
    const hashToSign = result.hashesToSign[j]
    console.log(`🔏 Getting signature for input ${j}: ${hashToSign}`)

    const hexSignature = await getSignatureForHash(
      relayMultisigSigner,
      hashToSign,
      "Ecdsa",
      {
        publicClient: resolved.publicClient,
        walletClient: resolved.walletClient,
      }
    )

    const { r, s, v } = parseSignature(hexSignature as `0x${string}`)
    signedHashes.push({
      r: r.slice(2),
      s: s.slice(2),
      v: Number(v),
    })
  }

  const builtTx = buildBitcoinTransactionFromPayload(result.transaction)

  await addSignedInputsToTransaction(
    builtTx,
    result.hashesToSign,
    signedHashes,
    result.transaction
  )

  const txid = await broadcastTransaction(builtTx)
  console.log(`✅ Bitcoin transaction confirmed: ${txid}`)
}

async function executeSolanaTransaction(
  tx: Extract<Transaction, { family: "solana-vm" }>,
  relayMultisigSigner: `0x${string}`,
  resolved: ResolvedNetwork
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
    {
      publicClient: resolved.publicClient,
      walletClient: resolved.walletClient,
    },
    true
  )

  const signatureBytes = new Uint8Array(
    Buffer.from(hexSignature.slice(2), "hex")
  )

  const derivationPath = relayMultisigSigner.toLowerCase()
  const predecessor = `${relayMultisigSigner.substring(2).toLowerCase()}.aurora`
  const domainId = 1

  const chainId = await resolved.publicClient.getChainId()
  const { near } = networks[chainId]
  const nearRpcUrl = near?.rpc ?? "https://free.rpc.fastnear.com"

  const nearSigner = (await resolved.publicClient.readContract({
    abi: [
      {
        inputs: [],
        name: "nearSigner",
        outputs: [{ name: "", type: "string" }],
        stateMutability: "view",
        type: "function",
      },
    ],
    address: relayMultisigSigner,
    functionName: "nearSigner",
  })) as string

  console.log(`Using NEAR signer: ${nearSigner}, RPC: ${nearRpcUrl}`)

  const { publicKey } = await derivePublicKey(
    derivationPath,
    predecessor,
    Number(domainId),
    nearSigner,
    nearRpcUrl
  )
  const feePayer = new PublicKey(bs58.decode(publicKey))

  transaction.addSignature(feePayer, signatureBytes)

  if (feePayer.toBase58() !== tx.from) {
    throw new Error(
      `❌ Signer does not match transaction sender... Got ${feePayer.toBase58()}`
    )
  }

  if (tx.nonceAccount && tx.nonceAccountAuth) {
    if (tx.nonceAccountAuth === tx.from) {
      console.log(
        `🔑 Nonce authority is MPC signer (${tx.nonceAccountAuth}), no additional signature needed`
      )
    } else {
      console.log(
        `🔑 Adding nonce authority signature for nonce account: ${tx.nonceAccount}`
      )

      const nonceAuthorityPrivateKey =
        process.env.SOLANA_NONCE_AUTHORITY_PRIVATE_KEY
      if (!nonceAuthorityPrivateKey) {
        throw new Error(
          "❌ Durable Nonce transaction requires SOLANA_NONCE_AUTHORITY_PRIVATE_KEY environment variable to be set"
        )
      }

      const nonceAuthorityKeypair = Keypair.fromSecretKey(
        bs58.decode(nonceAuthorityPrivateKey)
      )

      if (nonceAuthorityKeypair.publicKey.toBase58() !== tx.nonceAccountAuth) {
        throw new Error(
          `❌ Nonce authority private key does not match nonceAccountAuth. Expected: ${tx.nonceAccountAuth}, Got: ${nonceAuthorityKeypair.publicKey.toBase58()}`
        )
      }

      transaction.sign([nonceAuthorityKeypair])

      console.log("✅ Nonce authority signature added")
    }
  }

  const serializedTransaction = transaction.serialize()
  const signature = bs58.encode(transaction.signatures[0])
  const connection = new Connection(tx.rpc, "confirmed")

  await connection.sendRawTransaction(serializedTransaction, { maxRetries: 0 })

  console.log(`🚀 Transaction sent via ${tx.rpc}: ${signature}`)

  await connection.confirmTransaction(signature, "confirmed")

  console.log(`✅ Transaction confirmed: ${signature}`)
}

async function executeTronTransaction(
  tx: Extract<Transaction, { family: "tron-vm" }>,
  relayMultisigSigner: `0x${string}`,
  resolved: ResolvedNetwork
) {
  const {
    transaction,
    hashesToSign: [hashToSign],
  } = await buildTronTransaction(tx)

  const hexSignature = await getSignatureForHash(
    relayMultisigSigner,
    hashToSign,
    "Ecdsa",
    {
      publicClient: resolved.publicClient,
      walletClient: resolved.walletClient,
    }
  )

  const tronSignature = hexSignature.slice(2).toLowerCase()

  if (Array.isArray(transaction.signature)) {
    if (!transaction.signature.includes(tronSignature)) {
      transaction.signature.push(tronSignature)
    }
  } else {
    transaction.signature = [tronSignature]
  }

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

  const startTime = Date.now()
  const timeout = 60000

  let receipt: any
  while (!receipt || !Object.keys(receipt).length) {
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
      // skip
    }

    if (
      receipt &&
      receipt.receipt?.result &&
      receipt.receipt.result !== "SUCCESS"
    ) {
      throw new Error(`Transaction reverted: ${receipt.receipt.result}`)
    }

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

export function registerExecuteTransactions(program: Command) {
  program
    .command("execute-transactions")
    .description(
      "Execute transactions from a manifest file, signing them via the relay multisig signer."
    )
    .requiredOption(
      "-t, --transactions <path>",
      "Path to the transactions manifest JSON file"
    )
    .option(
      "--relay-multisig-signer <address>",
      "Address of the relay multisig signer (overrides --network lookup)"
    )
    .option("-n, --network <slug>", "Network slug (from settlement-networks)")
    .option("--rpc-url <url>", "RPC URL override")
    .action(
      async ({
        transactions: transactionsPath,
        relayMultisigSigner,
        network,
        rpcUrl,
      }) => {
        const resolved = resolveNetwork({
          multisigSignerOverride: relayMultisigSigner as
            | `0x${string}`
            | undefined,
          network,
          rpcOverride: rpcUrl,
        })

        const multisigSignerAddress = resolved.multisigSignerAddress

        const transactions = loadTransactions(transactionsPath)

        const signatureCount = countRequiredSignatures(transactions)
        await checkAndApproveWNEAR(
          resolved.publicClient,
          resolved.walletClient,
          resolved.chainId,
          resolved.walletClient.account.address,
          multisigSignerAddress,
          BigInt(signatureCount)
        )

        const failures: Array<{
          index: number
          tx: Transaction
          error: string
        }> = []

        for (let i = 0; i < transactions.length; i++) {
          console.log(`🏗️  Building transaction #${i}`)
          const tx = transactions[i]

          try {
            if (tx.family === "ethereum-vm") {
              await executeEvmTransaction(tx, multisigSignerAddress, resolved)
            } else if (tx.family === "bitcoin-vm") {
              await executeBitcoinTransaction(
                tx,
                multisigSignerAddress,
                resolved
              )
            } else if (tx.family === "solana-vm") {
              await executeSolanaTransaction(
                tx,
                multisigSignerAddress,
                resolved
              )
            } else if (tx.family === "tron-vm") {
              await executeTronTransaction(tx, multisigSignerAddress, resolved)
            } else {
              throw new Error(
                `Unsupported transaction family: ${(tx as Transaction).family}.`
              )
            }
          } catch (error: any) {
            const errorMsg =
              error.message || error.toString() || "Unknown error"
            console.error(`❌ Transaction #${i} failed: ${errorMsg}`)
            failures.push({ error: errorMsg, index: i, tx })
          }
        }

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
}
