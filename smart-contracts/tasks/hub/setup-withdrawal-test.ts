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
} from "@relay-protocol/settlement-sdk"
import { networks } from "@relay-protocol/settlement-networks"
import type { NetworkConfig } from "@relay-protocol/settlement-sdk"
import * as fs from "fs"
import * as path from "path"

/**
 * Dev environment configuration
 */
const DEV_CONFIG = {
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
  const network = Object.values(networks).find((n: any) => n.slug === slug) as
    | NetworkConfig
    | undefined
  if (!network) {
    const available = Object.values(networks)
      .map((n: any) => n.slug)
      .filter(Boolean)
      .sort()
      .join(", ")
    throw new Error(`Unknown chain "${slug}". Available: ${available}`)
  }
  return network
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
    const privateKey = process.env.DEPLOYER_PRIVATE_KEY
    if (!privateKey) {
      throw new Error("DEPLOYER_PRIVATE_KEY not set")
    }

    const pk = (
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    ) as Hex
    const account = privateKeyToAccount(pk)
    const depositAmount = parseEther(taskArgs.amount)
    const chainSlug = taskArgs.chain as string
    const dryRun = taskArgs.dryRun as boolean

    if (dryRun) {
      console.log("*** DRY RUN — no transactions will be sent ***\n")
    }

    // Resolve deposit chain from networks package
    const network = getNetworkBySlug(chainSlug)
    const depositChainId = Number(network.chainId)
    const depositRpc = network.rpc[0]
    // Use zeroHash as depositId so oracle mints to the user's generic virtual address
    // (non-zero depositId triggers getOrderAddress which creates an order-specific address)
    const depositId =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex

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

    const depositPublicClient = createPublicClient({
      chain: depositChain,
      transport: http(depositRpc),
    })

    const depositWallet = createWalletClient({
      account,
      chain: depositChain,
      transport: http(depositRpc),
    })

    console.log("=== Setup Withdrawal Test (Dev Environment) ===\n")
    console.log(`  Account:        ${account.address}`)
    console.log(`  Deposit chain:  ${network.name} (${depositChainId})`)
    console.log(`  Deposit amount: ${taskArgs.amount} ETH`)
    console.log(`  RPC:            ${depositRpc}`)
    console.log(`  Depository:     ${DEV_CONFIG.depository}`)
    console.log(`  Oracle API:     ${DEV_CONFIG.oracleApiUrl}`)

    // ========================================
    // Step 1: depositNative on deposit chain
    // ========================================
    let depositTxHash: Hex

    if (taskArgs.txHash) {
      // Skip deposit — reuse existing tx
      depositTxHash = taskArgs.txHash as Hex
      console.log("\n--- Step 1: Skipped (using existing tx) ---")
      console.log(`  Tx hash: ${depositTxHash}`)
    } else if (dryRun) {
      console.log("\n--- Step 1: Depositing to depository (dry run) ---")

      await depositPublicClient.simulateContract({
        abi: DEPOSITORY_ABI,
        account,
        address: DEV_CONFIG.depository,
        args: [account.address, depositId],
        functionName: "depositNative",
        value: depositAmount,
      })
      console.log("  Simulation OK — depositNative would succeed")
      console.log("  Skipping steps 2-4 (no real tx to attest)")

      // Check existing hub balance
      console.log("\n--- Checking current hub balance ---")
      const settlementClient = createPublicClient({
        chain: arbitrumSepolia,
        transport: http(DEV_CONFIG.settlementChain.rpcUrl),
      })

      const nativeCurrency = "0x0000000000000000000000000000000000000000"
      const ownerChainId = chainSlug

      const virtualAddress = generateAddress({
        address: account.address,
        chainId: ownerChainId,
        family: "ethereum-vm",
      })

      const tokenId = generateTokenId({
        address: nativeCurrency,
        chainId: ownerChainId,
        family: "ethereum-vm",
      })

      const hubBalance = await settlementClient.readContract({
        abi: RELAY_HUB_ABI,
        address: DEV_CONFIG.settlementChain.hubAddress,
        args: [virtualAddress, tokenId],
        functionName: "balanceOf",
      })

      console.log(`  Virtual address: ${virtualAddress}`)
      console.log(`  Token ID:        ${tokenId}`)
      console.log(`  Current hub balance: ${formatEther(hubBalance)} ETH`)
      console.log(
        "\n*** Dry run complete. Run without --dry-run to execute. ***"
      )
      return
    } else {
      console.log("\n--- Step 1: Depositing to depository ---")
      // Use zeroHash as depositId so oracle mints to the user's generic virtual address
      // (non-zero depositId triggers getOrderAddress which creates an order-specific address)
      const depositId =
        "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex

      depositTxHash = await depositWallet.writeContract({
        abi: DEPOSITORY_ABI,
        address: DEV_CONFIG.depository,
        args: [account.address, depositId],
        functionName: "depositNative",
        value: depositAmount,
      })

      console.log(`  Tx hash: ${depositTxHash}`)
      console.log("  Waiting for confirmation...")

      const depositReceipt =
        await depositPublicClient.waitForTransactionReceipt({
          hash: depositTxHash,
        })
      console.log(`  Confirmed in block ${depositReceipt.blockNumber}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 60 * 1000))

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

    const attestData = await attestResponse.json()

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
    const computedAddress = generateAddress({
      address: account.address,
      chainId: chainSlug,
      family: "ethereum-vm",
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
      account: account.address,
      deposit: {
        amount: taskArgs.amount,
        depositId,
        depository: DEV_CONFIG.depository,
        txHash: depositTxHash,
      },
      depositChain: {
        id: depositChainId,
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
    console.log(`\nHub balance created for ${account.address}`)
    console.log(
      `  Deposited ${taskArgs.amount} ETH from ${network.name} (${depositChainId})`
    )
    console.log("\nWithdrawal UI — select:")
    console.log(`  Chain: ${network.name}`)
    console.log("  Token: ETH (native)")
  })
