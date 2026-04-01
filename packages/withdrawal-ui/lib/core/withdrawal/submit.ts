import type { Address, WalletClient } from "viem"
import { parseSignature } from "viem"
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js"
import * as bitcoin from "bitcoinjs-lib"
import { SuiClient } from "@mysten/sui/client"
import { Transaction } from "@mysten/sui/transactions"
import type {
  EvmTransactionData,
  SolanaTransactionData,
  BitcoinTransactionData,
  TronTransactionData,
  SuiTransactionData,
  HyperliquidTransactionData,
} from "./types"

/**
 * Per-VM transaction submission — dispatches to the correct wallet/chain method.
 * Returns the submitted tx hash (or signature for Solana, digest for Sui).
 *
 * @param rpcUrl — chain RPC URL, required for Solana (to build transaction and broadcast)
 */
export async function submitTransaction(
  vmType: string,
  transaction: any,
  wallet: any,
  rpcUrl?: string
): Promise<string> {
  switch (vmType) {
    case "evm":
      return submitEvmTransaction(
        wallet as WalletClient,
        transaction as EvmTransactionData
      )

    case "svm":
      if (!rpcUrl)
        throw new Error("Solana RPC URL required for transaction submission")
      return submitSolanaTransaction(
        wallet,
        transaction as SolanaTransactionData,
        rpcUrl
      )

    case "bvm":
      if (!rpcUrl)
        throw new Error("Bitcoin API URL required for PSBT broadcast")
      return submitBitcoinTransaction(
        transaction as BitcoinTransactionData,
        rpcUrl
      )

    case "hypevm":
      return submitHyperliquidTransaction(
        transaction as HyperliquidTransactionData
      )

    case "tvm":
      return submitTronTransaction(wallet, transaction as TronTransactionData)

    case "suivm":
      if (!rpcUrl)
        throw new Error("Sui RPC URL required for transaction submission")
      return submitSuiTransaction(
        wallet,
        transaction as SuiTransactionData,
        rpcUrl
      )

    default:
      throw new Error(`Unsupported VM type for transaction: ${vmType}`)
  }
}

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

async function submitEvmTransaction(
  walletClient: WalletClient,
  tx: EvmTransactionData
): Promise<string> {
  const account = walletClient.account
  if (!account) throw new Error("Wallet not connected")

  return walletClient.sendTransaction({
    account,
    chain: null,
    to: tx.to as Address,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value),
    chainId: tx.chainId,
    gas: tx.gas ? BigInt(tx.gas) : undefined,
  })
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

/**
 * Poll getSignatureStatus until confirmed/finalized or timeout.
 * Unlike confirmTransaction, this does not depend on blockhash validity window
 * and won't throw TransactionExpiredBlockheightExceededError on slow RPCs.
 * On timeout we return without throwing — the solver verifies on-chain status.
 */
export async function pollSolanaConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    })
    if (value?.err) {
      throw new Error(
        `Transaction failed on-chain: ${JSON.stringify(value.err)}`
      )
    }
    if (
      value?.confirmationStatus === "confirmed" ||
      value?.confirmationStatus === "finalized"
    ) {
      return
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  // Timed out but tx was sent — return and let solver verify
}

/**
 * Build a VersionedTransaction from solver instructions, sign and send via Dynamic wallet.
 *
 * Flow:
 * 1. Convert solver instruction JSON → TransactionInstruction[]
 * 2. Resolve address lookup tables (if any)
 * 3. Build VersionedTransaction with recent blockhash
 * 4. Sign and send via Dynamic wallet's getSigner()
 * 5. Wait for confirmation
 */
async function submitSolanaTransaction(
  wallet: any,
  tx: SolanaTransactionData,
  rpcUrl: string
): Promise<string> {
  const connection = new Connection(rpcUrl, "confirmed")

  // Convert solver instructions to TransactionInstruction objects
  const instructions = tx.instructions.map(
    (ix) =>
      new TransactionInstruction({
        keys: ix.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        programId: new PublicKey(ix.programId),
        data: Buffer.from(
          ix.data.startsWith("0x") ? ix.data.slice(2) : ix.data,
          "hex"
        ),
      })
  )

  // Resolve address lookup tables for compact transaction format
  let lookupTables: AddressLookupTableAccount[] = []
  if (tx.addressLookupTableAddresses?.length) {
    const results = await Promise.all(
      tx.addressLookupTableAddresses.map((addr) =>
        connection.getAddressLookupTable(new PublicKey(addr))
      )
    )
    lookupTables = results
      .map((r) => r.value)
      .filter((t): t is AddressLookupTableAccount => t !== null)
  }

  // Get recent blockhash for transaction validity window
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed")

  // Build V0 transaction message
  const messageV0 = new TransactionMessage({
    payerKey: new PublicKey(wallet.address),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables.length > 0 ? lookupTables : undefined)

  const transaction = new VersionedTransaction(messageV0)

  // Sign and send via Dynamic wallet
  // Dynamic Solana wallet exposes getSigner() → { signAndSendTransaction }
  if (typeof wallet.getSigner === "function") {
    const signer = await wallet.getSigner()
    const result = await signer.signAndSendTransaction(transaction)
    return typeof result === "string" ? result : (result?.signature ?? result)
  }

  // Fallback: try signTransaction + sendRawTransaction
  if (typeof wallet.signTransaction === "function") {
    const signed = await wallet.signTransaction(transaction)
    return await connection.sendRawTransaction(signed.serialize())
  }

  throw new Error(
    "Solana wallet does not support transaction signing. Try a different wallet."
  )
}

// ---------------------------------------------------------------------------
// Bitcoin
// ---------------------------------------------------------------------------

/**
 * Finalize and broadcast a Bitcoin PSBT.
 *
 * The solver returns a PSBT with the allocator's signature (via NEAR MPC).
 * The user does NOT sign — we just finalize, extract the raw tx, and broadcast.
 * (Same pattern as relay-kit's relay-bitcoin-wallet-adapter)
 */
async function submitBitcoinTransaction(
  tx: BitcoinTransactionData,
  apiUrl: string
): Promise<string> {
  const psbt = bitcoin.Psbt.fromHex(tx.psbt)
  psbt.finalizeAllInputs()
  const rawTxHex = psbt.extractTransaction().toHex()

  const broadcastUrl = buildEsploraBroadcastUrl(apiUrl)

  const response = await fetch(broadcastUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: rawTxHex,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Bitcoin broadcast failed: ${errorText}`)
  }

  // Esplora returns the txid as plain text
  const txid = await response.text()
  return txid.trim()
}

// ---------------------------------------------------------------------------
// Hyperliquid
// ---------------------------------------------------------------------------

/**
 * Submit a pre-signed action to the Hyperliquid exchange API.
 *
 * For withdrawals, the allocator signs the exchange action (usdSend/sendAsset).
 * The transaction data from the solver includes the signer + signature.
 * The UI just needs to POST it to Hyperliquid's exchange endpoint.
 */
async function submitHyperliquidTransaction(
  tx: HyperliquidTransactionData
): Promise<string> {
  const isMainnet = tx.action.parameters.hyperliquidChain === "Mainnet"
  const apiUrl = isMainnet
    ? "https://api.hyperliquid.xyz/exchange"
    : "https://api.hyperliquid-testnet.xyz/exchange"

  // Hyperliquid exchange API expects signature as { r, s, v } object.
  // Solver sends raw hex from the allocator — parse here.
  const { r, s, v } = parseSignature(tx.signature as `0x${string}`)

  const payload = {
    action: {
      type: tx.action.type,
      ...tx.action.parameters,
      ...(tx.signatureChainId != null && {
        signatureChainId: tx.signatureChainId,
      }),
    },
    nonce: tx.nonce,
    signature: { r, s, v: Number(v) },
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Hyperliquid submission failed: ${errorText}`)
  }

  const result = await response.json()

  if (result?.status === "err") {
    throw new Error(`Hyperliquid error: ${result.response ?? "Unknown error"}`)
  }

  // usdSend/spotSend returns { status: "ok", response: { type: "default" } }
  // with no tx hash — return nonce as identifier (matches existing broadcastHyperliquidTransaction pattern)
  return result?.response?.data?.statuses?.[0]?.tx ?? `hype-nonce-${tx.nonce}`
}

// ---------------------------------------------------------------------------
// Tron
// ---------------------------------------------------------------------------

/**
 * Build, sign and broadcast a Tron transaction.
 *
 * Uses Dynamic's TronWallet.getTronWeb() to access the TronWeb instance,
 * matching relay-kit's relay-tron-wallet-adapter pattern.
 *
 * Flow: tronWeb.fullNode.request → tronWeb.trx.sign → tronWeb.trx.sendRawTransaction
 */
async function submitTronTransaction(
  wallet: any,
  tx: TronTransactionData
): Promise<string> {
  // Dynamic TronWallet exposes getTronWeb() — see relay-kit/relay-tron-wallet-adapter
  const tronWeb = wallet.getTronWeb?.() ?? (globalThis as any).tronWeb
  if (!tronWeb) {
    throw new Error("TronWeb not available. Connect a Tron wallet.")
  }

  let unsignedTx: any

  if (tx.type === "TriggerSmartContract") {
    const callBody = {
      owner_address: tx.parameter.owner_address,
      contract_address: tx.parameter.contract_address,
      data: (tx.parameter.data ?? "").replace(/^0x/, ""),
      call_value: tx.parameter.call_value ?? 0,
      visible: false,
    }

    // Estimate energy via dry-run (same as solver's triggerConstantContract)
    let feeLimit = 150_000_000 // fallback: 150 TRX
    try {
      const estimate = await tronWeb.fullNode.request(
        "wallet/triggerconstantcontract",
        callBody,
        "post"
      )
      if (estimate?.energy_used > 0) {
        // Fetch current energy price from chain (sun per energy unit)
        let sunPerEnergy = 420 // fallback — check if governance changed this
        try {
          const prices = await tronWeb.fullNode.request(
            "wallet/getenergyprices",
            {},
            "post"
          )
          if (prices?.prices) {
            // Format: "timestamp:price,timestamp:price,..." — last entry is current
            const last = prices.prices.split(",").pop()
            const price = Number(last?.split(":")[1])
            if (price > 0) sunPerEnergy = price
          }
        } catch {
          // Use fallback
        }
        // 2x buffer, floor 30 TRX
        feeLimit = Math.max(estimate.energy_used * sunPerEnergy * 2, 30_000_000)
      }
    } catch {
      // Use fallback fee_limit
    }

    // Smart contract call — use wallet/triggersmartcontract RPC
    const res = await tronWeb.fullNode.request(
      "wallet/triggersmartcontract",
      { ...callBody, fee_limit: feeLimit },
      "post"
    )
    if (!res?.transaction) {
      const pairs = (res?.result?.message as string | undefined)?.match(/.{2}/g)
      const reason = pairs
        ? new TextDecoder().decode(
            Uint8Array.from(pairs.map((b: string) => parseInt(b, 16)))
          )
        : "Unknown trigger error"
      throw new Error(`Tron trigger failed: ${reason}`)
    }
    unsignedTx = res.transaction
  } else {
    // Native TRX transfer — use wallet/createtransaction RPC
    unsignedTx = await tronWeb.transactionBuilder.sendTrx(
      tx.parameter.to_address,
      tx.parameter.amount ?? 0,
      tx.parameter.owner_address
    )
  }

  if (!unsignedTx) throw new Error("Failed to build Tron transaction")

  const signed = await tronWeb.trx.sign(unsignedTx)
  const broadcast = await tronWeb.trx.sendRawTransaction(signed)

  if (!broadcast?.result) {
    throw new Error(
      `Tron broadcast failed: ${broadcast?.message ?? "unknown error"}`
    )
  }

  return broadcast.txid || signed?.txID || unsignedTx.txID
}

export async function pollTronConfirmation(
  tronWeb: any,
  txId: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = await tronWeb.trx
      .getTransactionInfo(txId)
      .catch(() => undefined)
    if (info && typeof info.blockNumber === "number") {
      const result = info.receipt?.result as string | undefined
      if (result && result !== "SUCCESS") {
        throw new Error(`Tron transaction reverted: ${result}`)
      }
      return // confirmed
    }
    await new Promise((r) => setTimeout(r, 1_500))
  }
  // Timed out — return and let solver verify (same as Solana pattern)
}

// ---------------------------------------------------------------------------
// Sui
// ---------------------------------------------------------------------------

/**
 * Submit a Sui transaction via Dynamic's SuiWallet.
 *
 * Follows relay-kit's relay-sui-wallet-adapter pattern:
 * 1. Deserialize tx bytes via Transaction.from()
 * 2. Sign via wallet.signTransaction()
 * 3. Execute via walletClient.executeTransactionBlock()
 * 4. Confirm via SuiClient.waitForTransaction()
 */
async function submitSuiTransaction(
  wallet: any,
  tx: SuiTransactionData,
  rpcUrl: string
): Promise<string> {
  const client = new SuiClient({ url: rpcUrl })
  const transaction = Transaction.from(tx.data)

  // Dynamic SuiWallet: getWalletClient() + signTransaction()
  // See relay-kit demo: suiWallet.signTransaction(tx) → walletClient.executeTransactionBlock()
  if (typeof wallet.getWalletClient === "function") {
    const walletClient = await wallet.getWalletClient()
    const signed = await wallet.signTransaction(transaction)
    const result = await walletClient.executeTransactionBlock({
      signature: signed.signature,
      transactionBlock: signed.bytes,
      options: {},
    })

    await client.waitForTransaction({
      digest: result.digest,
      options: { showEffects: true },
    })

    return result.digest
  }

  // Fallback: getSigner pattern
  if (typeof wallet.getSigner === "function") {
    const signer = await wallet.getSigner()
    const result = await signer.signAndExecuteTransaction({ transaction })
    const digest = typeof result === "string" ? result : result?.digest
    if (!digest) throw new Error("Sui transaction returned no digest")

    await client.waitForTransaction({ digest })
    return digest
  }

  throw new Error("Sui wallet does not support transaction execution")
}

// ---------------------------------------------------------------------------
// Exported helpers (for testing)
// ---------------------------------------------------------------------------

/**
 * Normalize an Esplora-compatible base URL to the broadcast endpoint.
 * Handles both "https://mempool.space/api" and "https://mempool.space" inputs.
 */
export function buildEsploraBroadcastUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")
  return `${base}/api/tx`
}
