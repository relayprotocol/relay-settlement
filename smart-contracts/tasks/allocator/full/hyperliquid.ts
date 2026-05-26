import { task } from "hardhat/config"
import networks from "@relay-protocol/settlement-networks"
import {
  recoverTypedDataAddress,
  zeroAddress,
  encodeAbiParameters,
  keccak256,
  parseUnits,
} from "viem"
import {
  derivePublicKey,
  extractNearSignature,
} from "@relay-settlement/multisig-tools/crypto/near"
import { wait } from "@relay-settlement/multisig-tools/crypto/wait"
import { publicKeyToAddress } from "viem/utils"
import { checkAndApproveWNEAR } from "../../../lib/aurora"
import { base58 } from "@scure/base"
import {
  decodeHyperliquidPayload,
  getHyperliquidEIP712Types,
  getHyperliquidPrimaryType,
  createHyperliquidTxParams,
  buildHyperliquidApiPayload,
  broadcastHyperliquidTransaction,
  getLatestUserTxHash,
} from "../../../lib/hyperliquid"

task(
  "full:hyperliquid",
  "Deploy the Allocator contract, initializes it, sets a payload builder, submits a withdraw request, triggers a signature, and executes on Hyperliquid testnet"
)
  .addParam("owner", "The address of the owner")
  .addOptionalParam(
    "allocator",
    "The address of an existing RelayAllocator contract"
  )
  .addOptionalParam("signer", "The address of the signer")
  .addOptionalParam("wnear", "The address of the wNEAR token")
  .addOptionalParam("amount", "The amount to withdraw (decimal format)", "0.5")
  .addOptionalParam(
    "decimals",
    "Target decimal places for Hyperliquid format (will be configured in PayloadBuilder)",
    "2"
  )
  .addOptionalParam(
    "currency",
    "The currency to withdraw (empty for USD, token format for spots)",
    ""
  )
  .addParam("chainId", "The chain ID on which we withdraw")
  .addParam("recipient", "The recipient address on Hyperliquid")
  .addOptionalParam("signatureChainId", "The signature chain ID", "421614")
  .setAction(
    async (
      {
        owner,
        signer: _signer,
        wnear,
        amount,
        decimals,
        currency,
        chainId,
        recipient,
        signatureChainId,
        allocator: allocatorAddress,
      },
      hre
    ) => {
      const { viem, run } = hre
      // recompile contracts
      await run("compile")

      const hyperliquidSignatureChainId = BigInt(signatureChainId)
      const networkConfig = networks[chainId.toString()]
      const hyperliquidChain = networkConfig.isTestnet ? "Testnet" : "Mainnet"

      const publicClient = await viem.getPublicClient()

      if (!allocatorAddress) {
        throw new Error(
          "--allocator is required. Deploy one first with " +
            "`HUB=<hub> ORACLE=<oracle> yarn deploy:allocator` and pass " +
            "--allocator <address>."
        )
      }

      const allocator = await viem.getContractAt("Allocator", allocatorAddress)
      const delay = await allocator.read.delay()

      let payloadBuilderAddress = await allocator.read.payloadBuilders([
        hyperliquidSignatureChainId,
        zeroAddress, // No depository contract for Hyperliquid
      ])

      if (payloadBuilderAddress === zeroAddress) {
        console.log("PayloadBuilder not set, deploying a new one...")
        const payloadBuilderContract = await viem.deployContract(
          "HyperLiquidPayloadBuilder",
          [hyperliquidChain, owner] // Add owner as admin
        )
        console.log(
          `HyperLiquidPayloadBuilder deployed to: ${payloadBuilderContract.address}`
        )
        payloadBuilderAddress = payloadBuilderContract.address

        const tx = await allocator.write.setPayloadBuilder([
          hyperliquidSignatureChainId,
          zeroAddress, // No depository contract for Hyperliquid
          payloadBuilderAddress,
        ])
        await publicClient.waitForTransactionReceipt({
          hash: tx,
        })
      }
      console.log(`Payload builder: ${payloadBuilderAddress}`)

      // Get the payload builder contract instance
      const payloadBuilder = await viem.getContractAt(
        "HyperLiquidPayloadBuilder",
        payloadBuilderAddress
      )

      const targetDecimals = parseInt(decimals) // Target decimal places for Hyperliquid output format

      // Configure target decimals for the currency (empty string for Core USD, token identifier for spots)
      try {
        const setDecimalsTx = await payloadBuilder.write.setTargetDecimals([
          currency,
          targetDecimals,
        ])
        await publicClient.waitForTransactionReceipt({
          hash: setDecimalsTx,
        })
        console.log(
          `Target decimals set to ${targetDecimals} for currency: "${currency || "Core USD"}"`
        )
      } catch (error: any) {
        if (error.message.includes("AccessControlUnauthorizedAccount")) {
          console.log(
            "⚠️ Cannot set target decimals - not authorized. Using existing configuration."
          )
        } else {
          throw error
        }
      }

      await run("allocator:grant-withdrawer-role", {
        account: owner,
        allocator: allocatorAddress,
      })

      // Convert amount to 18-decimal precision and create data with only timestamp
      const amountInWei = parseUnits(amount, 18) // Convert to 18 decimal precision
      const currentTime = BigInt(Date.now()) // Current timestamp in milliseconds

      const data = encodeAbiParameters([{ type: "uint64" }], [currentTime])

      // Check and approve wNEAR allowance
      await checkAndApproveWNEAR(hre, owner, allocatorAddress)

      const nonce = keccak256(`0x${new Date().getTime().toString()}`)

      // Submit a withdraw request to the Allocator for Hyperliquid
      const payloadId = await run("allocator:submit-withdraw", {
        allocator: allocatorAddress,
        amount: amountInWei.toString(), // Now uses actual amount in 18 decimal precision
        chainId: hyperliquidSignatureChainId.toString(),
        currency,
        data,
        depository: zeroAddress,
        nonce,
        receiver: recipient,
      })

      // Get the payload
      const payload = await allocator.read.payloads([payloadId])

      // Trigger a signature
      await wait(Number(delay))

      await run("allocator:sign-payload", {
        allocator: allocatorAddress,
        amount: amountInWei.toString(), // Now uses actual amount in 18 decimal precision
        chainId: hyperliquidSignatureChainId.toString(),
        currency,
        data,
        depository: zeroAddress,
        nonce,
        payloadId,
        recipient,
        wnear,
      })

      // Verify that the signatures match (payloadBuilder already obtained above)
      const payloadHashes = await payloadBuilder.read.hashesToSign([
        hyperliquidSignatureChainId,
        zeroAddress, // No depository contract for Hyperliquid
        payload,
      ])

      // Wait for the signature to arrive
      let signedPayload = await allocator.read.signedPayloads([
        payloadId,
        payloadHashes[0],
      ])
      while (signedPayload === "0x") {
        console.log("Waiting for signed payload...")
        await wait(1)
        signedPayload = await allocator.read.signedPayloads([
          payloadId,
          payloadHashes[0],
        ])
      }

      const { r, s, v } = extractNearSignature(signedPayload)

      const signature =
        `0x${r}${s}${v.toString(16).padStart(2, "0")}` as `0x${string}`

      // Decode the payload to understand the transaction structure
      const { type: txType, request } = decodeHyperliquidPayload(payload)

      // Create the typed data structure for Hyperliquid
      const types = getHyperliquidEIP712Types(txType)
      const primaryType = getHyperliquidPrimaryType(txType)

      const derivationPath = allocatorAddress.toLowerCase()
      const predecessor = `${allocatorAddress.substring(2).toLowerCase()}.aurora`
      const domainId = 0 // 0 for ECDSA

      // Get the public key from the NEAR contract
      const { publicKey: allocatorPublicKeyRaw } = await derivePublicKey(
        derivationPath,
        predecessor,
        Number(domainId)
      )

      // NajPublicKey to UncompressedPubKeySEC1
      const allocatorPublicKey = `0x04${Buffer.from(base58.decode(allocatorPublicKeyRaw)).toString("hex")}`

      // UncompressedPubKeySEC1 to Address
      const signerAddress = publicKeyToAddress(
        allocatorPublicKey as `0x${string}`
      )

      // EIP-712 verification for Hyperliquid
      const recoveredFromTypedData = await recoverTypedDataAddress({
        domain: {
          chainId: Number(hyperliquidSignatureChainId),
          name: await payloadBuilder.read.EIP712_DOMAIN_NAME(),
          verifyingContract: zeroAddress,
          version: await payloadBuilder.read.EIP712_DOMAIN_VERSION(),
        },
        message: request as any, // Cast to any to handle type compatibility
        primaryType,
        signature,
        types,
      })

      if (signerAddress !== recoveredFromTypedData) {
        throw new Error(
          `Recovered addresses do not match: ${signerAddress} !== ${recoveredFromTypedData}`
        )
      }

      console.log("🔍 Recovered address (Hyperliquid signer):", signerAddress)
      console.log("🔍 Recovered public key:", allocatorPublicKey)

      // Generate transaction parameters for Hyperliquid client
      const txParams = createHyperliquidTxParams(request, txType)

      console.log("🚀 Transaction ready for Hyperliquid testnet execution")
      console.log("Transaction parameters:", txParams)

      console.log("📡 Complete transaction data for Hyperliquid:")
      console.log({
        payload: safeStringify(request),
        signature,
        signer: signerAddress,
        txParams: safeStringify(txParams),
        type: txType.toLowerCase(),
      })

      // Build API payload for Hyperliquid
      const apiPayload = buildHyperliquidApiPayload(
        request,
        txType,
        { r, s, v },
        `0x${hyperliquidSignatureChainId.toString(16)}` // Convert chain ID to hex
      )

      try {
        // Record timestamp before broadcast
        const broadcastTime = Date.now()

        // Broadcast transaction to Hyperliquid
        const result = await broadcastHyperliquidTransaction(
          apiPayload,
          networkConfig.rpc[0]
        )
        console.log("Transaction broadcast result:", result)

        // Wait 2 seconds for transaction to be processed
        console.log("\n⏳ Waiting 2 seconds for transaction confirmation...")
        await wait(2)

        // Query the latest transaction hash for the signer address
        const txHash = await getLatestUserTxHash(
          signerAddress,
          networkConfig.explorerApiUrl!,
          broadcastTime
        )

        if (txHash) {
          const explorerUrl =
            hyperliquidChain === "Testnet"
              ? `https://app.hyperliquid-testnet.xyz/explorer/tx/${txHash}`
              : `https://app.hyperliquid.xyz/explorer/tx/${txHash}`

          console.log("\n✅ Full e2e test completed successfully!")
          console.log(
            `🔗 Transaction confirmed on Hyperliquid ${hyperliquidChain}`
          )
          console.log(`   Transaction Hash: ${txHash}`)
          console.log(`   Explorer Link: ${explorerUrl}`)
        } else {
          console.log(
            "\n⚠️ Transaction broadcast completed but confirmation not found yet"
          )
          console.log(
            "This might be normal if the transaction is still being processed"
          )
        }
      } catch (error) {
        console.error("❌ Failed to broadcast transaction:", error)
        console.log("📡 Transaction data that failed to broadcast:")
        console.log("API Payload:", JSON.stringify(apiPayload, null, 2))
        throw error
      }
    }
  )

const safeStringify = (obj: any) =>
  JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v))
