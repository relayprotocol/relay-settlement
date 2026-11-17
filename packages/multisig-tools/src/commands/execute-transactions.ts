import type { Command } from "commander"
import { mkdirSync, writeFileSync } from "fs"
import { dirname } from "path"
import { signMessageEntry } from "../helpers/messageSigning"
import { executionIndices } from "../helpers/executionIndices"
import { assertEvmFeeCap } from "../helpers/evmFeeCap"
import { fundingBalance, getFundingCurrency } from "../helpers/fundingCurrency"
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseSignature,
  parseTransaction,
  type PublicClient,
  recoverAddress,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerialized,
  WaitForTransactionReceiptTimeoutError,
  zeroAddress,
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
import {
  assertEnvOrSigner,
  resolveNetwork,
  type ResolvedNetwork,
} from "../helpers/network"
import { checkAndApproveWNEAR } from "../helpers/wnear"
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
import { PublicKey, Keypair, Connection } from "@solana/web3.js"
import * as tronweb from "tronweb"

async function ensureFunding(
  tx: Extract<Transaction, { family: "ethereum-vm" }>
) {
  const networkClient = createPublicClient({ transport: http(tx.rpc) })
  const destinationChainId = await networkClient.getChainId()
  const gasLimit = BigInt(tx.gas)
  const gasPrice = tx.maxFeePerGas
    ? BigInt(tx.maxFeePerGas)
    : tx.gasPrice
      ? BigInt(tx.gasPrice)
      : await networkClient.getGasPrice()

  const currency = await getFundingCurrency(
    networkClient,
    destinationChainId,
    tx,
    gasLimit,
    gasPrice
  )
  const isToken = currency.address !== zeroAddress
  const currentBalance = await fundingBalance(networkClient, currency, tx.from)
  const formatBalance = (balance: bigint) =>
    formatUnits(balance, currency.decimals)
  const estimatedGasCost = currency.gasCost
  const requiredAmount = (estimatedGasCost * 150n) / 100n
  const shortfall = requiredAmount - currentBalance
  const minimumBridgeAmount = isToken ? 10000n : 500000000000000n // 0.01 USD or 0.0005 native
  const amountToBridge =
    shortfall > minimumBridgeAmount ? shortfall : minimumBridgeAmount

  const destinationChainName =
    networks[destinationChainId.toString()]?.name ||
    `chain ${destinationChainId}`

  console.log(
    `💰 Need to fund ${tx.from} with ${formatBalance(amountToBridge)} ${currency.symbol}`
  )
  console.log(
    `   Current: ${formatBalance(currentBalance)}, Required: ${formatBalance(requiredAmount)}, Amount: ${formatBalance(amountToBridge)}`
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

  const deployerBalance = await fundingBalance(
    networkClient,
    currency,
    deployerAddress
  )
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

    const transferHash = await directWalletClient.sendTransaction(
      isToken
        ? {
            data: encodeFunctionData({
              abi: erc20Abi,
              args: [tx.from, amountToBridge],
              functionName: "transfer",
            }),
            to: currency.address,
            value: 0n,
          }
        : { to: tx.from, value: amountToBridge }
    )
    console.log(`   Transfer tx: ${transferHash}`)
    const receipt = await networkClient.waitForTransactionReceipt({
      hash: transferHash,
    })
    if (receipt.status !== "success") {
      throw new Error(`Funding transfer reverted: ${transferHash}`)
    }

    const newBalance = await fundingBalance(networkClient, currency, tx.from)
    if (newBalance < requiredAmount) {
      throw new Error(
        `Funding transfer did not provide enough ${currency.symbol} to ${tx.from}`
      )
    }
    console.log(
      `✅ Funding complete via direct transfer! New balance: ${formatBalance(newBalance)} ${currency.symbol}`
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

  const relayHeaders: Record<string, string> = {}
  if (process.env.RELAY_API_KEY) {
    relayHeaders["x-api-key"] = process.env.RELAY_API_KEY
  }

  const quoteResponse = await fetch("https://api.relay.link/quote", {
    body: JSON.stringify({
      amount: amountToBridge.toString(),
      destinationChainId,
      destinationCurrency: currency.address,
      options: { swapOnOrigin: false },
      originChainId: sourceChainId,
      originCurrency: "0x0000000000000000000000000000000000000000",
      recipient: tx.from,
      referrer: "relay.settlement",
      tradeType: isToken ? "EXACT_OUTPUT" : "EXACT_INPUT",
      user: deployerAddress,
    }),
    headers: { ...relayHeaders, "Content-Type": "application/json" },
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

    const newBalance = await fundingBalance(networkClient, currency, tx.from)

    if (
      newBalance > currentBalance &&
      (!isToken || newBalance >= requiredAmount)
    ) {
      console.log(
        `✅ Funding complete! New balance: ${formatBalance(newBalance)} ${currency.symbol} (was: ${formatBalance(currentBalance)})`
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
          `https://api.relay.link/requests/status?hash=${bridgeHash}`,
          { headers: relayHeaders }
        )
        if (statusResponse.ok) {
          const status = (await statusResponse.json()) as any
          if (status.status === "refunded" || status.status === "failed") {
            throw new Error(
              `Bridge was ${status.status}. Reason: ${status.inTxs?.[0]?.statusReason || "Unknown"}`
            )
          }
          console.log(
            `   Still waiting... (${attempts * 5}s elapsed) - Balance: ${formatBalance(newBalance)} ${currency.symbol}, Status: ${status.status || "unknown"}`
          )
        } else {
          console.log(
            `   Still waiting... (${attempts * 5}s elapsed) - Balance: ${formatBalance(newBalance)} ${currency.symbol}`
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
          `   Still waiting... (${attempts * 5}s elapsed) - Balance: ${formatBalance(newBalance)} ${currency.symbol}`
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

  const networkClient = createPublicClient({ transport: http(tx.rpc) })
  await assertEvmFeeCap(networkClient, transaction.maxFeePerGas)

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

  const gasLimit = BigInt(transaction.gas || 0)
  const gasPrice = transaction.maxFeePerGas
    ? BigInt(transaction.maxFeePerGas)
    : transaction.gasPrice
      ? BigInt(transaction.gasPrice)
      : await networkClient.getGasPrice()

  // Relay chains don't require the signer to hold a native balance, so skip
  // the pre-broadcast funding check there.
  const RELAY_CHAIN_IDS = [
    537713, // relay mainnet
    537724, // relay testnet
  ]
  const chainId = await networkClient.getChainId()
  const isRelayChain = RELAY_CHAIN_IDS.includes(chainId)
  const currency = await getFundingCurrency(
    networkClient,
    chainId,
    tx,
    gasLimit,
    gasPrice
  )
  const currentBalance = await fundingBalance(
    networkClient,
    currency,
    transaction.from
  )
  const formatBalance = (balance: bigint) =>
    formatUnits(balance, currency.decimals)

  const estimatedGasCost = currency.gasCost
  const txValue = transaction.value ? BigInt(transaction.value) : 0n
  const requiredBalance = isRelayChain ? 0n : estimatedGasCost + txValue

  if (currentBalance < requiredBalance) {
    console.log(
      `⚠️  Insufficient ${currency.symbol} balance detected before broadcast. Current: ${formatBalance(currentBalance)}, Required: ${formatBalance(requiredBalance)}`
    )
    await ensureFunding(tx)

    const newBalance = await fundingBalance(
      networkClient,
      currency,
      transaction.from
    )
    if (newBalance < requiredBalance) {
      throw new Error(
        `Insufficient ${currency.symbol} after funding attempt. Have: ${formatBalance(newBalance)}, Need: ${formatBalance(requiredBalance)}`
      )
    }
    console.log(
      `✅ Funding successful, new balance: ${formatBalance(newBalance)} ${currency.symbol}`
    )
  }

  try {
    await broadcastAndConfirm(networkClient, serializedTransaction, tx.rpc)
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
      await broadcastAndConfirm(networkClient, serializedTransaction, tx.rpc)
    } else {
      throw error
    }
  }
}

// A signed raw tx has a fixed hash, so a broadcast timeout is not a failure yet: wait for
// that hash before re-sending; a rejection (e.g. the relay chain's gas meter) is retried after a pause.
export const BROADCAST_ATTEMPTS = 6
const CONFIRM_TIMEOUT_MS = 90_000
export const REJECTION_BACKOFF_MS = 20_000
const FEE_HISTORY_BLOCKS = 20

const recoverSender = (serializedTransaction: `0x${string}`) =>
  recoverTransactionAddress({
    serializedTransaction: serializedTransaction as TransactionSerialized,
  })

const backoff = () =>
  new Promise((resolve) => setTimeout(resolve, REJECTION_BACKOFF_MS))

// Lowest base fee over the recent blocks; falls back to the latest block when the RPC
// lacks eth_feeHistory, and is undefined on chains without a base fee (legacy fees).
async function recentBaseFeeFloor(
  networkClient: PublicClient
): Promise<bigint | undefined> {
  try {
    const { baseFeePerGas } = await networkClient.getFeeHistory({
      blockCount: FEE_HISTORY_BLOCKS,
      rewardPercentiles: [],
    })
    const fees = baseFeePerGas.filter((fee) => fee > 0n)
    return fees.length > 0
      ? fees.reduce((min, fee) => (fee < min ? fee : min))
      : undefined
  } catch {
    const block = await networkClient.getBlock().catch(() => undefined)
    return block?.baseFeePerGas ?? undefined
  }
}

export async function broadcastAndConfirm(
  networkClient: PublicClient,
  serializedTransaction: `0x${string}`,
  rpc: string
) {
  const hash = keccak256(serializedTransaction)
  // A tx is only includable in blocks whose base fee is <= its max fee, so a manifest
  // fee below the recent base-fee floor has no chance soon: fail fast with the numbers.
  const parsed = parseTransaction(serializedTransaction)
  const maxFee = parsed.maxFeePerGas ?? parsed.gasPrice
  const baseFeeFloor =
    maxFee === undefined ? undefined : await recentBaseFeeFloor(networkClient)
  if (
    maxFee !== undefined &&
    baseFeeFloor !== undefined &&
    maxFee < baseFeeFloor
  ) {
    const message = `Transaction ${hash} is underpriced: manifest fee ${maxFee} wei/gas is below the lowest base fee of the last ${FEE_HISTORY_BLOCKS} blocks (${baseFeeFloor} wei/gas)`
    // FORCE_BROADCAST=1 sends anyway and spends the attempts waiting for a fee dip.
    if (process.env.FORCE_BROADCAST !== "1") {
      throw new Error(
        `${message} -- wait for fees to drop, regenerate the manifest for this chain, or set FORCE_BROADCAST=1`
      )
    }
    console.log(`⚠️  ${message}; FORCE_BROADCAST=1, broadcasting anyway`)
  }
  // Honor the same override for already-signed transactions when the latest
  // fee rises above the cap, even if earlier blocks were cheaper.
  if (process.env.FORCE_BROADCAST !== "1") {
    await assertEvmFeeCap(networkClient, parsed.maxFeePerGas)
  }
  for (let attempt = 1; attempt <= BROADCAST_ATTEMPTS; attempt++) {
    try {
      await networkClient.sendRawTransaction({ serializedTransaction })
      console.log(`🚀 Transaction sent via ${rpc}: ${hash}`)
    } catch (error: any) {
      const message = String(
        error?.details ?? error?.shortMessage ?? error?.message ?? error
      )
      const lower = message.toLowerCase()
      if (
        lower.includes("insufficient funds") ||
        lower.includes("insufficient balance") ||
        lower.includes("gas * price + value")
      ) {
        throw error
      }
      const timedOut =
        lower.includes("took too long") || lower.includes("timed out")
      const alreadyKnown =
        lower.includes("already known") ||
        lower.includes("alreadyknown") ||
        lower.includes("known transaction")
      const nonceUsed =
        lower.includes("nonce too low") || lower.includes("oldnonce")
      if (nonceUsed) {
        // Either our earlier send was mined (node evicted it) or another tx took the
        // nonce; only the first case has a receipt for our hash to wait for.
        const ours = await networkClient
          .getTransaction({ hash })
          .catch(() => null)
        if (!ours) {
          const count = await networkClient.getTransactionCount({
            address: await recoverSender(serializedTransaction),
          })
          throw new Error(
            `Transaction ${hash} can never land: nonce ${parsed.nonce} was consumed by another transaction (sender count is ${count})`
          )
        }
        console.log(`⏳ ${hash} was already mined, fetching its receipt...`)
      } else if (alreadyKnown) {
        console.log(`⏳ ${hash} is already in the mempool, waiting for it...`)
      } else if (!timedOut) {
        // The node refused the tx outright, so there is no receipt to wait for.
        console.log(
          `⚠️  Broadcast attempt ${attempt}/${BROADCAST_ATTEMPTS} rejected; retrying in ${REJECTION_BACKOFF_MS / 1000}s...`
        )
        console.log(error)
        if (attempt < BROADCAST_ATTEMPTS) await backoff()
        continue
      } else {
        console.log(
          `⚠️  Broadcast attempt ${attempt}/${BROADCAST_ATTEMPTS} timed out; checking whether ${hash} landed...`
        )
      }
    }
    try {
      const receipt = await networkClient.waitForTransactionReceipt({
        hash,
        timeout: CONFIRM_TIMEOUT_MS,
      })
      if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
        // viem follows nonce replacements: a different hash means our tx was replaced.
        throw new Error(
          `Transaction ${hash} was replaced by ${receipt.transactionHash} (same nonce)`
        )
      }
      if (receipt.status !== "success") {
        // The nonce is consumed either way, so a re-run's nonce check would skip
        // this transaction as executed -- surface the revert instead.
        throw new Error(`Transaction reverted: ${receipt.transactionHash}`)
      }
      console.log(`✅ Transaction confirmed: ${receipt.transactionHash}`)
      return
    } catch (error: any) {
      const text = String(error?.message ?? "")
      if (
        text.startsWith("Transaction reverted") ||
        text.includes("was replaced by")
      ) {
        throw error
      }
      if (error instanceof WaitForTransactionReceiptTimeoutError) {
        console.log(
          `⏳ ${hash} not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s, re-broadcasting...`
        )
      } else {
        console.log(
          `⏳ ${hash} receipt lookup failed, retrying in ${REJECTION_BACKOFF_MS / 1000}s...`
        )
        console.log(error)
        if (attempt < BROADCAST_ATTEMPTS) await backoff()
      }
    }
  }
  throw new Error(
    `Transaction ${hash} was not accepted after ${BROADCAST_ATTEMPTS} broadcast attempts`
  )
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
    .option(
      "--indices <indices>",
      "Execute only these comma-separated zero-based manifest indices, in manifest order"
    )
    .option(
      "--signatures-output <path>",
      "New output file for sign-only message results"
    )
    .option(
      "-e, --env <env>",
      "Deployment env for the --network contract lookup (prod | dev | stag | test | deployers); required unless --relay-multisig-signer is set"
    )
    .action(
      async ({
        transactions: transactionsPath,
        relayMultisigSigner,
        network,
        rpcUrl,
        signaturesOutput,
        indices,
        env,
      }) => {
        assertEnvOrSigner({ env, multisigSignerOverride: relayMultisigSigner })
        const resolved = resolveNetwork({
          env,
          multisigSignerOverride: relayMultisigSigner as
            | `0x${string}`
            | undefined,
          network,
          rpcOverride: rpcUrl,
        })

        const multisigSignerAddress = resolved.multisigSignerAddress

        const transactions = loadTransactions(transactionsPath)
        const selectedIndices = executionIndices(transactions.length, indices)
        const selectedTransactions = selectedIndices.map(
          (index) => transactions[index]
        )
        const messageResults: Array<
          Awaited<ReturnType<typeof signMessageEntry>> & { index: number }
        > = []
        if (selectedTransactions.some((tx) => tx.family === "message")) {
          if (!signaturesOutput)
            throw new Error("Message entries require --signatures-output")
          mkdirSync(dirname(signaturesOutput), { recursive: true })
          // Refuse overwrites before requesting any signatures. Partial successes
          // are saved after each message; retries can collect cached signatures.
          writeFileSync(signaturesOutput, "[]\n", { flag: "wx", mode: 0o600 })
        }

        const signatureCount = countRequiredSignatures(selectedTransactions)
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

        // Once a tx from a sender fails on a chain, its later txs there would only queue
        // behind the nonce gap and burn the retry budget each: skip them explicitly.
        const brokenLanes = new Set<string>()
        const laneOf = (tx: Transaction) =>
          tx.family === "ethereum-vm" ? `${tx.from}@${tx.rpc}` : undefined

        for (const i of selectedIndices) {
          console.log(`🏗️  Building transaction #${i}`)
          const tx = transactions[i]
          const lane = laneOf(tx)
          if (lane && brokenLanes.has(lane)) {
            const [sender, rpc] = lane.split("@")
            const errorMsg = `skipped: an earlier transaction from ${sender} on ${rpc} failed in this run`
            console.error(`⏭️  Transaction #${i} ${errorMsg}`)
            failures.push({ error: errorMsg, index: i, tx })
            continue
          }

          try {
            if (tx.family === "ethereum-vm") {
              await executeEvmTransaction(tx, multisigSignerAddress, resolved)
            } else if (tx.family === "message") {
              const result = await signMessageEntry(
                tx,
                multisigSignerAddress,
                resolved
              )
              messageResults.push({ index: i, ...result })
              writeFileSync(
                signaturesOutput,
                JSON.stringify(messageResults, null, 2) + "\n"
              )
              console.log(
                `Message #${i} signed without broadcasting; saved to ${signaturesOutput}`
              )
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
            if (lane) brokenLanes.add(lane)
          }
        }

        console.log(`\n${"=".repeat(80)}`)
        console.log(
          `\n✅ Successfully executed ${selectedIndices.length - failures.length}/${selectedIndices.length} selected entries`
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
