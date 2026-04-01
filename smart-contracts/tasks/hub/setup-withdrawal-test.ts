import { task } from "hardhat/config"
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  defineChain,
  decodeAbiParameters,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { arbitrumSepolia } from "viem/chains"
import {
  generateAddress,
  generateTokenId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk"
import { networks } from "@relay-protocol/settlement-networks"
import type { NetworkConfig, VmType } from "@relay-protocol/settlement-sdk"
import * as fs from "fs"
import * as path from "path"
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import bs58 from "bs58"
import * as bitcoin from "bitcoinjs-lib"
import ECPairFactory from "ecpair"
import * as tinysecp from "tiny-secp256k1"

/**
 * Dev environment configuration
 */
const DEV_CONFIG = {
  bitcoinDepository: "1MviEDGCTgEKEJ6cmfL9pBQa5GG4hujXnF",
  bitcoinEsploraUrl: process.env.BITCOIN_ESPLORA_URL ?? "https://mempool.space",
  depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" as `0x${string}`,
  oracleApiUrl: process.env.ORACLE_API_URL,
  settlementChain: {
    hubAddress: "0xB505c75F4d135C65a9806E2b8Ff72B1816BE931C" as `0x${string}`,
    id: 421614,
    oracleAddress:
      "0xF7692E62495C472863490eE06499b50cE133BaBd" as `0x${string}`,
    oracleMultisigAddress:
      "0x17a6bAF4811e1F12d225B41d39cA7745A8E36520" as `0x${string}`,
    oracleMultisigSigners: [
      "0xF24a399259f47C6360d00da3793eca9Cc6ad1Caa",
      "0xcDA3c24706c1a5EEA958A988693e8A838D520aF9",
    ],
    oracleMultisigThreshold: 2,
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  },
  solanaDepository: "6TMx4zgh9Ho5DaJtaQbKbHgYLk7B6vKEoE7CfnxkqcHv",
}

const DEPOSITORY_ABI = [
  {
    inputs: [
      { name: "depositor", type: "address" },
      { name: "id", type: "bytes32" },
    ],
    name: "depositNative",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const

const ORACLE_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "idempotencyKey", type: "bytes32" },
          { name: "actions", type: "bytes[]" },
        ],
        name: "executions",
        type: "tuple[]",
      },
      { name: "oracle", type: "address" },
      { name: "signatures", type: "bytes[]" },
    ],
    name: "executeMultiple",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

const RELAY_HUB_ABI = [
  {
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const

function getNetworkBySlug(slug: string): NetworkConfig {
  const network = Object.values(networks).find(
    (n: NetworkConfig) => n.slug === slug
  ) as NetworkConfig | undefined
  if (!network) {
    const available = Object.values(networks)
      .map((n: NetworkConfig) => n.slug)
      .filter(Boolean)
      .sort()
      .join(", ")
    throw new Error(`Unknown chain "${slug}". Available: ${available}`)
  }
  return network
}

/** Map chain slug to SDK VM family string */
function getVmFamily(slug: string): string {
  const map: Record<string, string> = {
    bitcoin: "bitcoin-vm",
    solana: "solana-vm",
  }
  return map[slug] ?? "ethereum-vm"
}

// deposit_native discriminator from Solana depository IDL
const SOLANA_DEPOSIT_NATIVE_DISC = Buffer.from([
  13, 158, 13, 223, 95, 213, 28, 6,
])

async function depositSolanaDepository(
  rpcUrl: string,
  keypair: Keypair,
  depositoryProgramId: string,
  lamports: bigint
): Promise<string> {
  const connection = new Connection(rpcUrl, "confirmed")
  const programId = new PublicKey(depositoryProgramId)

  const [relayDepositoryPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("relay_depository")],
    programId
  )
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    programId
  )

  // instruction data: discriminator | amount u64 LE | id [u8;32] all zeros
  const amountBuf = Buffer.alloc(8)
  amountBuf.writeBigUInt64LE(lamports)
  const data = Buffer.concat([
    SOLANA_DEPOSIT_NATIVE_DISC,
    amountBuf,
    Buffer.alloc(32),
  ])

  const ix = new TransactionInstruction({
    data,
    keys: [
      { isSigner: false, isWritable: false, pubkey: relayDepositoryPDA },
      { isSigner: true, isWritable: true, pubkey: keypair.publicKey },
      { isSigner: false, isWritable: false, pubkey: keypair.publicKey }, // depositor = sender
      { isSigner: false, isWritable: true, pubkey: vaultPDA },
      { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
    ],
    programId,
  })

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash()
  const message = new TransactionMessage({
    instructions: [ix],
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  tx.sign([keypair])

  const signature = await connection.sendRawTransaction(tx.serialize())
  await connection.confirmTransaction(
    { blockhash, lastValidBlockHeight, signature },
    "confirmed"
  )
  return signature
}

/**
 * Send BTC to the Bitcoin depository address.
 * Fetches UTXOs from the sender's address via Esplora API, builds a P2PKH tx,
 * signs with the provided WIF key, and broadcasts.
 * Returns the transaction ID.
 */
async function depositBitcoinDepository(
  privateKeyWif: string,
  depositoryAddress: string,
  satoshis: bigint,
  esploraUrl: string
): Promise<string> {
  const ECPair = ECPairFactory(tinysecp)
  const isTestnet =
    depositoryAddress.startsWith("m") ||
    depositoryAddress.startsWith("n") ||
    depositoryAddress.startsWith("2") ||
    depositoryAddress.startsWith("tb1")
  const network = isTestnet
    ? bitcoin.networks.testnet
    : bitcoin.networks.bitcoin

  const keyPair = ECPair.fromWIF(privateKeyWif, network)
  const p2wpkh = bitcoin.payments.p2wpkh({
    network,
    pubkey: Buffer.from(keyPair.publicKey),
  })
  const senderAddress = p2wpkh.address!
  console.log(`  Bitcoin sender: ${senderAddress}`)

  // Fetch UTXOs
  const utxosRes = await fetch(
    `${esploraUrl}/api/address/${senderAddress}/utxo`
  )
  if (!utxosRes.ok)
    throw new Error(`Failed to fetch UTXOs: ${utxosRes.statusText}`)
  const utxos = (await utxosRes.json()) as {
    txid: string
    vout: number
    value: number
  }[]
  if (utxos.length === 0)
    throw new Error(`No UTXOs for ${senderAddress} — fund it first`)

  // Select UTXOs to cover amount + fee (rough 1000 sat fee estimate)
  const feeBuffer = 1000n
  const target = satoshis + feeBuffer
  let inputTotal = 0n
  const selected: typeof utxos = []
  for (const u of utxos.sort((a, b) => b.value - a.value)) {
    selected.push(u)
    inputTotal += BigInt(u.value)
    if (inputTotal >= target) break
  }
  if (inputTotal < target)
    throw new Error(
      `Insufficient BTC: need ${target} sat, have ${inputTotal} sat`
    )

  // Build PSBT — P2WPKH uses witnessUtxo (no need to fetch full raw tx)
  const psbt = new bitcoin.Psbt({ network })
  for (const u of selected) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: {
        script: p2wpkh.output!,
        value: u.value,
      },
    })
  }
  psbt.addOutput({ address: depositoryAddress, value: Number(satoshis) })
  const change = inputTotal - satoshis - feeBuffer
  if (change > 546n)
    psbt.addOutput({ address: senderAddress, value: Number(change) })

  psbt.signAllInputs(keyPair)
  psbt.finalizeAllInputs()
  const txHex = psbt.extractTransaction().toHex()

  // Broadcast
  const broadcastRes = await fetch(`${esploraUrl}/api/tx`, {
    body: txHex,
    headers: { "Content-Type": "text/plain" },
    method: "POST",
  })
  if (!broadcastRes.ok)
    throw new Error(`Bitcoin broadcast failed: ${await broadcastRes.text()}`)

  return await broadcastRes.text() // txid
}

/**
 * Create hub balance for withdrawal UI testing via dev environment.
 *
 * Connects directly to chains via RPC from @relay-protocol/settlement-networks.
 * Does NOT depend on hardhat --network flag.
 *
 * Flow: depositNative on deposit chain → attest via oracle API → execute on Arbitrum Sepolia
 *
 * Prerequisites:
 *   - VPN connected (for oracle API access)
 *   - DEPLOYER_PRIVATE_KEY in env (with ETH on deposit chain + Arbitrum Sepolia)
 *
 * Usage:
 *   npx hardhat setup-withdrawal-test --chain arbitrum --amount 0.001
 *   npx hardhat setup-withdrawal-test --chain arbitrum --dry-run   # simulate only, no real tx
 */
task(
  "setup-withdrawal-test",
  "Create hub balance via dev environment (deposit → attest → execute)"
)
  .addParam("chain", "Deposit chain slug (e.g. arbitrum, base, ethereum)")
  .addOptionalParam("amount", "Amount of native ETH to deposit", "0.001")
  .addOptionalParam(
    "txHash",
    "Skip step 1 — use existing deposit tx hash to retry from step 2"
  )
  .addFlag("dryRun", "Simulate transactions without sending (no ETH spent)")
  .addOptionalParam("output", "Output JSON path", "./withdrawal-test-data.json")
  .setAction(async (taskArgs) => {
    const chainSlug = taskArgs.chain as string
    const dryRun = taskArgs.dryRun as boolean
    const vmFamily = getVmFamily(chainSlug)

    // Resolve deposit chain from networks package
    const network = getNetworkBySlug(chainSlug)
    const depositRpc = network.rpc[0]

    if (dryRun) {
      console.log("*** DRY RUN — no transactions will be sent ***\n")
    }

    // DEPLOYER_PRIVATE_KEY is always required — used for the settlement chain tx (Steps 3-4)
    const privateKey = process.env.DEPLOYER_PRIVATE_KEY
    if (!privateKey) {
      throw new Error("DEPLOYER_PRIVATE_KEY not set")
    }
    const pk = (
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    ) as Hex
    const account = privateKeyToAccount(pk)

    // Use zeroHash as depositId so oracle mints to the user's generic virtual address
    // (non-zero depositId triggers getOrderAddress which creates an order-specific address)
    const depositId =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex

    // ---- EVM deposit chain clients (only for ethereum-vm) ----
    let depositPublicClient: ReturnType<typeof createPublicClient> | null = null
    let depositWallet: ReturnType<typeof createWalletClient> | null = null
    if (vmFamily === "ethereum-vm") {
      const depositChainId = Number(network.chainId)
      const depositChain = defineChain({
        id: depositChainId,
        name: network.name,
        nativeCurrency: network.nativeCurrency ?? {
          decimals: 18,
          name: "ETH",
          symbol: "ETH",
        },
        rpcUrls: { default: { http: [depositRpc] } },
      })
      depositPublicClient = createPublicClient({
        chain: depositChain,
        transport: http(depositRpc),
      })
      depositWallet = createWalletClient({
        account,
        chain: depositChain,
        transport: http(depositRpc),
      })
    }

    // ---- Solana keypair (only for solana-vm) ----
    let solanaKeypair: Keypair | null = null
    if (vmFamily === "solana-vm") {
      const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY
      if (!solanaPrivateKey) throw new Error("SOLANA_PRIVATE_KEY not set")
      try {
        solanaKeypair = Keypair.fromSecretKey(bs58.decode(solanaPrivateKey))
      } catch {
        // Fallback: JSON array format
        solanaKeypair = Keypair.fromSecretKey(
          Uint8Array.from(JSON.parse(solanaPrivateKey))
        )
      }
    }

    // ---- Bitcoin WIF key + P2WPKH sender address (only for bitcoin-vm) ----
    let bitcoinPrivateKeyWif: string | null = null
    let bitcoinSenderAddress: string | null = null
    if (vmFamily === "bitcoin-vm") {
      const wif = process.env.BITCOIN_PRIVATE_KEY
      if (!wif) throw new Error("BITCOIN_PRIVATE_KEY not set (WIF format)")
      bitcoinPrivateKeyWif = wif
      // Derive the P2WPKH (bc1q) address — this is what the oracle uses as owner
      const ECPair = ECPairFactory(tinysecp)
      const keyPair = ECPair.fromWIF(wif, bitcoin.networks.bitcoin)
      const p2wpkh = bitcoin.payments.p2wpkh({
        network: bitcoin.networks.bitcoin,
        pubkey: Buffer.from(keyPair.publicKey),
      })
      bitcoinSenderAddress = p2wpkh.address!
    }

    const displayAccount =
      vmFamily === "solana-vm"
        ? solanaKeypair!.publicKey.toBase58()
        : vmFamily === "bitcoin-vm"
          ? bitcoinSenderAddress!
          : account.address
    const displayDepository =
      vmFamily === "solana-vm"
        ? DEV_CONFIG.solanaDepository
        : vmFamily === "bitcoin-vm"
          ? DEV_CONFIG.bitcoinDepository
          : DEV_CONFIG.depository
    const depositAmount =
      vmFamily === "ethereum-vm" ? parseEther(taskArgs.amount) : 0n

    console.log("=== Setup Withdrawal Test (Dev Environment) ===\n")
    console.log(`  Account:        ${displayAccount}`)
    console.log(`  Deposit chain:  ${network.name} (${chainSlug})`)
    const nativeUnit =
      vmFamily === "solana-vm"
        ? "SOL"
        : vmFamily === "bitcoin-vm"
          ? "BTC"
          : "ETH"
    console.log(`  Deposit amount: ${taskArgs.amount} ${nativeUnit}`)
    console.log(`  RPC:            ${depositRpc}`)
    console.log(`  Depository:     ${displayDepository}`)
    console.log(`  Oracle API:     ${DEV_CONFIG.oracleApiUrl}`)

    // ========================================
    // Step 1: depositNative on deposit chain
    // ========================================
    let depositTxHash: string

    if (taskArgs.txHash) {
      // Skip deposit — reuse existing tx
      depositTxHash = taskArgs.txHash as string
      console.log("\n--- Step 1: Skipped (using existing tx) ---")
      console.log(`  Tx hash: ${depositTxHash}`)
    } else if (dryRun) {
      console.log("\n--- Step 1: Depositing to depository (dry run) ---")

      if (vmFamily === "ethereum-vm") {
        await depositPublicClient!.simulateContract({
          abi: DEPOSITORY_ABI,
          account,
          address: DEV_CONFIG.depository,
          args: [account.address, depositId],
          functionName: "depositNative",
          value: depositAmount,
        })
        console.log("  Simulation OK — depositNative would succeed")
      } else if (vmFamily === "solana-vm") {
        console.log(
          `  Would call deposit_native on ${DEV_CONFIG.solanaDepository}`
        )
        console.log(`  Amount: ${taskArgs.amount} SOL`)
      } else if (vmFamily === "bitcoin-vm") {
        console.log(
          `  Would send ${taskArgs.amount} BTC to ${DEV_CONFIG.bitcoinDepository}`
        )
      }
      console.log("  Skipping steps 2-4 (no real tx to attest)")

      // Check existing hub balance
      console.log("\n--- Checking current hub balance ---")
      const settlementClient = createPublicClient({
        chain: arbitrumSepolia,
        transport: http(DEV_CONFIG.settlementChain.rpcUrl),
      })

      const ownerAddress =
        vmFamily === "solana-vm"
          ? solanaKeypair!.publicKey.toBase58()
          : vmFamily === "bitcoin-vm"
            ? bitcoinSenderAddress!
            : account.address
      const nativeCurrency = getVmTypeNativeCurrency(vmFamily as VmType)

      const virtualAddress = generateAddress({
        address: ownerAddress,
        chainId: chainSlug,
        family: vmFamily as VmType,
      })

      const tokenId = generateTokenId({
        address: nativeCurrency,
        chainId: chainSlug,
        family: vmFamily as VmType,
      })

      const hubBalance = await settlementClient.readContract({
        abi: RELAY_HUB_ABI,
        address: DEV_CONFIG.settlementChain.hubAddress,
        args: [virtualAddress, tokenId],
        functionName: "balanceOf",
      })

      console.log(`  Virtual address: ${virtualAddress}`)
      console.log(`  Token ID:        ${tokenId}`)
      console.log(`  Current hub balance: ${formatEther(hubBalance)}`)
      console.log(
        "\n*** Dry run complete. Run without --dry-run to execute. ***"
      )
      return
    } else if (vmFamily === "solana-vm") {
      console.log("\n--- Step 1: Depositing to Solana depository ---")
      const lamports = BigInt(
        Math.floor(parseFloat(taskArgs.amount) * LAMPORTS_PER_SOL)
      )

      depositTxHash = await depositSolanaDepository(
        depositRpc,
        solanaKeypair!,
        DEV_CONFIG.solanaDepository,
        lamports
      )

      console.log(`  Tx signature: ${depositTxHash}`)
      console.log("  Confirmed")
    } else if (vmFamily === "bitcoin-vm") {
      console.log("\n--- Step 1: Depositing to Bitcoin depository ---")
      const satoshis = BigInt(Math.round(parseFloat(taskArgs.amount) * 1e8))
      console.log(`  Amount: ${taskArgs.amount} BTC (${satoshis} sat)`)
      console.log(`  Depository: ${DEV_CONFIG.bitcoinDepository}`)

      depositTxHash = await depositBitcoinDepository(
        bitcoinPrivateKeyWif!,
        DEV_CONFIG.bitcoinDepository,
        satoshis,
        DEV_CONFIG.bitcoinEsploraUrl
      )

      console.log(`  Tx ID: ${depositTxHash}`)
    } else {
      console.log("\n--- Step 1: Depositing to depository ---")

      depositTxHash = await (depositWallet! as any).writeContract({
        abi: DEPOSITORY_ABI,
        address: DEV_CONFIG.depository,
        args: [account.address, depositId],
        functionName: "depositNative",
        value: depositAmount,
      })

      console.log(`  Tx hash: ${depositTxHash}`)
      console.log("  Waiting for confirmation...")

      const depositReceipt =
        await depositPublicClient!.waitForTransactionReceipt({
          hash: depositTxHash as Hex,
        })
      console.log(`  Confirmed in block ${depositReceipt.blockNumber}`)
    }

    if (vmFamily === "bitcoin-vm") {
      // Bitcoin needs 1 block confirmation (~10-15 min). Poll Esplora until confirmed.
      console.log(
        "\n  Waiting for Bitcoin confirmation (polling every 30s, up to 30 min)..."
      )
      const deadline = Date.now() + 30 * 60 * 1000
      let confirmed = false
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30_000))
        const statusRes = await fetch(
          `${DEV_CONFIG.bitcoinEsploraUrl}/api/tx/${depositTxHash}`
        )
        if (statusRes.ok) {
          const txData = (await statusRes.json()) as any
          if (txData?.status?.confirmed) {
            console.log(`  Confirmed in block ${txData.status.block_height}`)
            confirmed = true
            break
          }
        }
        console.log(
          `  Not yet confirmed, retrying... (${Math.round((deadline - Date.now()) / 60000)}m left)`
        )
      }
      if (!confirmed)
        throw new Error("Bitcoin tx not confirmed within 30 minutes")
    } else {
      console.log("\n  Waiting 60s for finalization...")
      await new Promise((resolve) => setTimeout(resolve, 60 * 1000))
    }

    // ========================================
    // Step 2: Attest via oracle API
    // ========================================
    console.log("\n--- Step 2: Attesting deposit via oracle ---")
    console.log(`  Calling oracle: chainId=${chainSlug}, tx=${depositTxHash}`)

    const attestResponse = await fetch(
      `${DEV_CONFIG.oracleApiUrl}/attestations/depository-deposits/v1`,
      {
        body: JSON.stringify({
          chainId: chainSlug,
          requestPeerSignatures: true,
          transactionId: depositTxHash,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    )

    if (!attestResponse.ok) {
      const body = await attestResponse.text()
      throw new Error(
        `Oracle attestation failed (${attestResponse.status}): ${body}`
      )
    }

    const attestData = (await attestResponse.json()) as any

    if (!attestData.execution) {
      throw new Error(
        "Oracle returned no execution — deposit may not have been recognized"
      )
    }

    console.log("  Attestation received:")
    console.log(`    Idempotency key: ${attestData.execution.idempotencyKey}`)
    console.log(`    Actions: ${attestData.execution.actions.length}`)
    console.log(`    Signatures: ${attestData.execution.signatures.length}`)

    if (attestData.messages?.length) {
      for (const msg of attestData.messages) {
        console.log(
          `    Deposit: ${msg.result.amount} of ${msg.result.currency} from ${msg.result.depositor}`
        )
      }
    }

    // ========================================
    // Step 3: Execute on settlement chain (Arbitrum Sepolia)
    // ========================================
    console.log("\n--- Step 3: Executing on settlement chain ---")

    const settlementClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(DEV_CONFIG.settlementChain.rpcUrl),
    })

    const settlementWallet = createWalletClient({
      account,
      chain: arbitrumSepolia,
      transport: http(DEV_CONFIG.settlementChain.rpcUrl),
    })

    // handleExecutionSignature — matches solver logic exactly
    const info = DEV_CONFIG.settlementChain

    // 1. Filter: only keep sigs matching our settlement chain + known signers
    const validSigs = attestData.execution.signatures.filter((s: any) => {
      if (Number(s.oracleChainId) !== info.id) return false
      if (s.oracleContract.toLowerCase() !== info.oracleAddress.toLowerCase())
        return false
      if (
        !info.oracleMultisigSigners
          .map((a) => a.toLowerCase())
          .includes(s.oracleSigner.toLowerCase())
      )
        return false
      return true
    })

    // 2. Threshold check
    if (validSigs.length < info.oracleMultisigThreshold) {
      throw new Error(
        `Insufficient signatures: got ${validSigs.length}, need ${info.oracleMultisigThreshold}`
      )
    }

    // 3. Sort by signer address, concat into one aggregated signature
    const aggregatedSignature = ("0x" +
      validSigs
        .sort((a: any, b: any) =>
          BigInt(a.oracleSigner) <= BigInt(b.oracleSigner) ? -1 : 1
        )
        .map((s: any) => s.signature.slice(2))
        .join("")) as Hex

    // Result matches solver's handleExecutionSignature return:
    //   oracleContract = info.oracle (base oracle)
    //   oracleSigner   = info.oracleMultisig
    //   signature      = aggregatedSignature
    const oracleSigner = info.oracleMultisigAddress

    console.log(`  Oracle multisig: ${oracleSigner}`)
    console.log(
      `  Valid signers: ${validSigs.map((s: any) => s.oracleSigner).join(", ")}`
    )
    console.log(
      `  Aggregated sig: ${(aggregatedSignature.length - 2) / 2} bytes`
    )

    // 4. Call executeMultiple on the BASE oracle contract
    //    Base oracle verifies sigs via multisig's isValidSignature (EIP-1271)
    const executeTxHash = await settlementWallet.writeContract({
      // base oracle has executeMultiple
      abi: ORACLE_ABI,
      address: info.oracleAddress,
      args: [
        [
          {
            actions: attestData.execution.actions,
            idempotencyKey: attestData.execution.idempotencyKey,
          },
        ],
        oracleSigner,
        [aggregatedSignature],
      ],
      functionName: "executeMultiple",
    })

    console.log(`  Tx hash: ${executeTxHash}`)
    console.log("  Waiting for confirmation...")

    const executeReceipt = await settlementClient.waitForTransactionReceipt({
      hash: executeTxHash,
    })
    console.log(`  Confirmed in block ${executeReceipt.blockNumber}`)

    // ========================================
    // Step 4: Verify hub balance
    // ========================================
    console.log("\n--- Step 4: Verifying hub balance ---")

    // Decode the MINT action to get the exact hubToAddress and hubTokenId the oracle used
    // Action encoding: (uint8 actionType, address hubToAddress, uint256 hubTokenId, uint256 amount)
    const actionData = attestData.execution.actions[0] as Hex
    const [actionType, hubToAddress, hubTokenId, mintAmount] =
      decodeAbiParameters(
        [
          { name: "actionType", type: "uint8" },
          { name: "hubToAddress", type: "address" },
          { name: "hubTokenId", type: "uint256" },
          { name: "amount", type: "uint256" },
        ],
        actionData
      )

    console.log(`  Action type:     ${actionType} (0=MINT)`)
    console.log(`  Hub to address:  ${hubToAddress}`)
    console.log(`  Hub token ID:    ${hubTokenId}`)
    console.log(`  Mint amount:     ${formatEther(mintAmount)} ETH`)

    // Also compute what we would derive — for debugging
    // Oracle uses chain slug (e.g. "ethereum") not numeric ID ("1")
    const ownerAddressForDerive =
      vmFamily === "solana-vm"
        ? solanaKeypair!.publicKey.toBase58()
        : vmFamily === "bitcoin-vm"
          ? bitcoinSenderAddress!
          : account.address
    const computedAddress = generateAddress({
      address: ownerAddressForDerive,
      chainId: chainSlug,
      family: vmFamily as VmType,
    })
    if (computedAddress.toLowerCase() !== hubToAddress.toLowerCase()) {
      console.log(
        `\n  Note: computed address (slug="${chainSlug}"): ${computedAddress}`
      )
      console.log(`  Oracle's address: ${hubToAddress}`)
      console.log("  Using oracle's address for balance check")
    } else {
      console.log(`  Computed address matches oracle (slug="${chainSlug}")`)
    }

    const hubBalance = await settlementClient.readContract({
      abi: RELAY_HUB_ABI,
      address: DEV_CONFIG.settlementChain.hubAddress,
      args: [hubToAddress, hubTokenId],
      functionName: "balanceOf",
    })

    console.log(
      `  Hub balance:     ${formatEther(hubBalance)} ETH (${hubBalance} wei)`
    )

    if (hubBalance === 0n) {
      console.warn(
        "\n  Warning: Hub balance is 0 — execution may not have minted correctly"
      )
    }

    // ========================================
    // Output
    // ========================================
    const testData = {
      account: displayAccount,
      deposit: {
        amount: taskArgs.amount,
        depositId,
        depository: displayDepository,
        txHash: depositTxHash,
      },
      depositChain: {
        id: chainSlug,
        name: network.name,
        slug: chainSlug,
      },
      execution: {
        settlementChainId: DEV_CONFIG.settlementChain.id,
        txHash: executeTxHash,
      },
      hubBalance: {
        balance: hubBalance.toString(),
        balanceFormatted: formatEther(hubBalance),
        tokenId: hubTokenId.toString(),
        virtualAddress: hubToAddress,
      },
      hubConfig: {
        chainId: DEV_CONFIG.settlementChain.id,
        hubAddress: DEV_CONFIG.settlementChain.hubAddress,
      },
    }

    const outputPath = path.resolve(taskArgs.output)
    fs.writeFileSync(outputPath, JSON.stringify(testData, null, 2))

    console.log("\n=== Done ===")
    console.log(`\nSaved: ${outputPath}`)
    console.log(`\nHub balance created for ${displayAccount}`)
    console.log(
      `  Deposited ${taskArgs.amount} ${nativeUnit} from ${network.name} (${chainSlug})`
    )
    console.log("\nWithdrawal UI — select:")
    console.log(`  Chain: ${network.name}`)
    console.log("  Token: ETH (native)")
  })
