import { task } from "hardhat/config"
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  recoverMessageAddress,
  serializeTransaction,
  zeroAddress,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  SignerClient,
  ApiClient,
  AccountApi,
  TransactionApi,
} from "@reservoir0x/lighter-ts-sdk"
import { extractNearSignature } from "../../../lib/near"
import { wait } from "../../../lib/wait"
import { publicKeyToAddress } from "viem/utils"
import { derivePublicKey } from "../../../lib/near"
import { base58 } from "@scure/base"
import { checkAndApproveWNEAR } from "../../../lib/aurora"
import { generateLighterApiKey } from "../../../lib/lighter/generateApiKey"

const LIGHTER_GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7"

const LIGHTER_PAYLOAD_ABI = parseAbiParameters([
  "(uint8 actionType, bytes parameters)",
])
const CHANGE_PUB_KEY_TX_ABI = parseAbiParameters([
  "(uint256 txNonce, uint256 gasPrice, uint256 gasLimit, bytes data)",
])
const LIGHTER_TRANSFER_REQUEST_ABI = parseAbiParameters([
  "(uint64 nonce, uint64 fromAccountIndex, uint64 fromRouteType, uint64 apiKeyIndex, uint64 toAccountIndex, uint64 toRouteType, uint64 assetIndex, uint64 amount, uint64 usdcFee, uint64 lighterChainId, bytes32 memo)",
])

/** Reconstruct the Transfer L1 message (must match Solidity buildTransferL1Message) */
function buildTransferL1Message(p: {
  nonce: bigint
  fromAccountIndex: bigint
  fromRouteType: bigint
  apiKeyIndex: bigint
  toAccountIndex: bigint
  toRouteType: bigint
  assetIndex: bigint
  amount: bigint
  usdcFee: bigint
  lighterChainId: bigint
  memo: string
}): string {
  const h16 = (v: bigint) => "0x" + v.toString(16).padStart(16, "0")
  return [
    "Transfer",
    "",
    `nonce: ${h16(p.nonce)}`,
    `from: ${h16(p.fromAccountIndex)} (route ${h16(p.fromRouteType)})`,
    `api key: ${h16(p.apiKeyIndex)}`,
    `to: ${h16(p.toAccountIndex)} (route ${h16(p.toRouteType)})`,
    `asset: ${h16(p.assetIndex)}`,
    `amount: ${h16(p.amount)}`,
    `fee: ${h16(p.usdcFee)}`,
    `chainId: ${h16(p.lighterChainId)}`,
    `memo: ${p.memo.padEnd(64, "0")}`,
    "Only sign this message for a trusted client!",
  ].join("\n")
}

task(
  "full:lighter",
  "Deploy Allocator + LighterPayloadBuilder, run ChangePubKey setup, then Transfer flow with MPC signature verification"
)
  .addOptionalParam("owner", "The address of the owner")
  .addOptionalParam("signer", "The address of the signer")
  .addOptionalParam("wnear", "The address of the wNEAR token")
  .addOptionalParam(
    "allocator",
    "The address of an existing allocator contract"
  )
  .addFlag("dryRun", "Only deploy allocator + derive MPC address, then stop")
  .addParam("recipient", "The destination account index on Lighter (e.g. 42)")
  .addOptionalParam(
    "ethRpcUrl",
    "Ethereum RPC URL for ChangePubKey broadcast",
    "https://eth.drpc.org"
  )
  .addOptionalParam(
    "lighterApiUrl",
    "Lighter API URL",
    "https://mainnet.zklighter.elliot.ai"
  )
  .addOptionalParam(
    "pubkey",
    "API key public key (hex, no 0x). If omitted, generates via WASM signer"
  )
  .addOptionalParam(
    "fromAccountIndex",
    "Override depository account index (default: auto-query from Lighter API)"
  )
  .addOptionalParam("lighterChainId", "Lighter chain ID for L1 message", "304")
  .addOptionalParam("assetIndex", "Asset index to withdraw", "3")
  .addOptionalParam("amount", "Amount to withdraw (raw)", "2000000")
  .addOptionalParam("apiKeyIndex", "API key index for the transfer", "5")
  .addOptionalParam("fromRouteType", "From route type", "0")
  .addOptionalParam("toRouteType", "To route type", "0")
  .addOptionalParam("usdcFee", "USDC fee for the transfer", "0")
  .addOptionalParam(
    "ethMainnetChainId",
    "Ethereum mainnet chain ID for ChangePubKey tx",
    "1"
  )
  .addOptionalParam(
    "depositAmount",
    "USDC amount (raw, 6 decimals) to deposit via Lighter gateway if MPC has no account",
    "10000000"
  )
  .setAction(
    async (
      {
        dryRun,
        owner,
        signer,
        wnear,
        allocator: existingAllocatorAddress,
        recipient,
        ethRpcUrl,
        lighterApiUrl,
        pubkey: pubkeyParam,
        fromAccountIndex: fromAccountIndexParam,
        lighterChainId,
        assetIndex,
        amount,
        apiKeyIndex,
        fromRouteType,
        toRouteType,
        usdcFee,
        ethMainnetChainId,
        depositAmount,
      },
      hre
    ) => {
      const { viem, run } = hre

      await run("compile")

      const [admin] = await viem.getWalletClients()
      console.log("admin", admin.account.address)
      const publicClient = await viem.getPublicClient()

      if (!owner) {
        owner = admin.account.address
      }

      // Shared Ethereum mainnet helpers (used by deposit + ChangePubKey)
      const ethChain = {
        id: Number(ethMainnetChainId),
        name: "ethereum",
      } as any
      const deployerKey = (
        process.env.DEPLOYER_PRIVATE_KEY!.startsWith("0x")
          ? process.env.DEPLOYER_PRIVATE_KEY!
          : `0x${process.env.DEPLOYER_PRIVATE_KEY!}`
      ) as `0x${string}`

      // ================================================================
      // Step 1: Deploy Allocator
      // ================================================================
      let allocatorAddress = existingAllocatorAddress
      if (!allocatorAddress) {
        allocatorAddress = await run("deploy:allocator", {
          owner,
          signer,
          wnear,
        })
      }
      console.log(`Allocator: ${allocatorAddress}`)

      const allocator = await viem.getContractAt(
        "RelayAllocator",
        allocatorAddress
      )
      const delay = await allocator.read.delay()

      // ================================================================
      // Step 2: Derive MPC address & resolve Lighter account index
      // ================================================================
      const derivationPath = allocatorAddress.toLowerCase()
      const predecessor = `${allocatorAddress.substring(2).toLowerCase()}.aurora`
      const { publicKey: allocatorPublicKeyRaw } = await derivePublicKey(
        derivationPath,
        predecessor,
        0
      )
      const allocatorPublicKey = `0x04${Buffer.from(base58.decode(allocatorPublicKeyRaw)).toString("hex")}`
      const signerAddress = publicKeyToAddress(
        allocatorPublicKey as `0x${string}`
      )
      console.log(`\n🔑 MPC signer address: ${signerAddress}`)

      // Resolve fromAccountIndex: use param override or query Lighter API
      const lighterApi = new AccountApi(new ApiClient({ host: lighterApiUrl }))
      let fromAccountIndex!: string
      if (fromAccountIndexParam) {
        fromAccountIndex = fromAccountIndexParam
        console.log(`Using provided fromAccountIndex: ${fromAccountIndex}`)
      } else {
        let accountData: any
        try {
          accountData = await lighterApi.getAccountsByL1Address(signerAddress)
        } catch {
          // API throws for unknown addresses
        }
        const subAccounts = accountData?.sub_accounts || accountData
        const account = Array.isArray(subAccounts)
          ? subAccounts[0]
          : subAccounts
        // Check if account exists AND has balance — skip deposit if so
        let needsDeposit = account?.index == null
        if (account?.index != null) {
          fromAccountIndex = String(account.index)
          try {
            const acctInfo = (await lighterApi.getAccount({
              by: "index",
              value: fromAccountIndex,
            })) as any

            const acct = acctInfo?.accounts?.[0] || acctInfo
            const balance = Number(
              acct?.collateral || acct?.available_balance || 0
            )
            if (balance > 0) {
              console.log(
                `Resolved fromAccountIndex=${fromAccountIndex}, balance=${balance} — skipping deposit`
              )
            } else {
              console.log(
                `Resolved fromAccountIndex=${fromAccountIndex}, balance=0 — depositing USDC...`
              )
              needsDeposit = true
            }
          } catch {
            console.log(
              `Resolved fromAccountIndex=${fromAccountIndex} — could not check balance, skipping deposit`
            )
          }
        }

        if (needsDeposit) {
          if (account?.index == null) {
            console.log(
              `\n⚠️ MPC address ${signerAddress} has no Lighter account yet. Depositing USDC via gateway...`
            )
          }

          // Deposit USDC to MPC address via Lighter gateway on Ethereum
          const ethClient = createPublicClient({ transport: http(ethRpcUrl) })
          const adminEth = createWalletClient({
            account: privateKeyToAccount(deployerKey),
            chain: ethChain,
            transport: http(ethRpcUrl),
          })
          const USDC_ETH =
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`
          const gatewayAddress = LIGHTER_GATEWAY as `0x${string}`

          const approveAbi = parseAbi([
            "function approve(address spender, uint256 amount)",
          ])
          const depositAbi = parseAbi([
            "function deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount)",
          ])

          // Approve USDC to gateway
          console.log(
            `Approving ${depositAmount} USDC to gateway from ${adminEth.account.address}...`
          )
          const approveTx = await adminEth.sendTransaction({
            account: adminEth.account,
            chain: ethChain,
            data: encodeFunctionData({
              abi: approveAbi,
              args: [gatewayAddress, BigInt(depositAmount)],
              functionName: "approve",
            }),
            to: USDC_ETH,
          } as any)
          await ethClient.waitForTransactionReceipt({ hash: approveTx })
          console.log(`   Approved: ${approveTx}`)

          // Deposit to MPC address
          console.log(`Depositing ${depositAmount} USDC to ${signerAddress}...`)
          const depositTx = await adminEth.sendTransaction({
            account: adminEth.account,
            chain: ethChain,
            data: encodeFunctionData({
              abi: depositAbi,
              args: [
                signerAddress,
                Number(assetIndex),
                0,
                BigInt(depositAmount),
              ],
              functionName: "deposit",
            }),
            to: gatewayAddress,
          } as any)
          await ethClient.waitForTransactionReceipt({ hash: depositTx })
          console.log(`   Deposited: ${depositTx}`)

          // Poll for account creation on Lighter
          console.log("Waiting for Lighter to process deposit...")
          for (let i = 0; i < 300; i++) {
            try {
              const pollData = (await lighterApi.getAccountsByL1Address(
                signerAddress
              )) as any
              const pollSub = pollData?.sub_accounts || pollData
              const pollAccount = Array.isArray(pollSub) ? pollSub[0] : pollSub
              if (pollAccount?.index) {
                fromAccountIndex = String(pollAccount.index)
                console.log(
                  `✅ Account created after ${i + 1}s: fromAccountIndex=${fromAccountIndex}`
                )
                break
              }
            } catch {
              // not ready yet
            }
            if (i === 299) {
              throw new Error(
                "Timed out waiting for Lighter to create account after deposit (300s)"
              )
            }
            await wait(1)
          }
        }
        // fromAccountIndex already set in needsDeposit poll or balance check above
      }

      if (dryRun) {
        console.log("\n========== Dry Run Summary ==========")
        console.log(`Allocator:        ${allocatorAddress}`)
        console.log(`MPC signer:       ${signerAddress}`)
        console.log(`Account index:    ${fromAccountIndex}`)
        console.log(
          `\nNext: deposit to ${signerAddress} on Lighter, then run without --dry-run`
        )
        return
      }

      // ================================================================
      // Resolve API key pair (env vars > --pubkey param > SDK generation)
      // ================================================================
      let pubkey = pubkeyParam
      let apiKeyPrivateKey: string | undefined
      if (
        process.env.LIGHTER_API_KEY_PRIVATE &&
        process.env.LIGHTER_API_KEY_PUBLIC
      ) {
        apiKeyPrivateKey = process.env.LIGHTER_API_KEY_PRIVATE
        pubkey = process.env.LIGHTER_API_KEY_PUBLIC
        console.log("\nUsing API key pair from env vars")
        console.log(`  Private key: ${apiKeyPrivateKey.slice(0, 16)}...`)
        console.log(`  Public key:  ${pubkey.slice(0, 20)}...`)
      } else if (!pubkey) {
        // Generate API key via SDK SignerClient
        // NOTE: Current SDK WASM binary may produce keys rejected by the API
        // ("invalid PublicKey, update the sdk to the latest version").
        // If this happens, generate keys from https://lighter.exchange and use env vars instead.
        const keyPair = await generateLighterApiKey({
          accountIndex: Number(fromAccountIndex),
          apiKeyIndex: Number(apiKeyIndex),
          url: lighterApiUrl,
        })
        pubkey = keyPair.publicKey
        apiKeyPrivateKey = keyPair.privateKey
        console.log("\nGenerated API key pair via SDK")
        console.log(`  Private key: ${apiKeyPrivateKey.slice(0, 16)}...`)
        console.log(`  Public key:  ${pubkey.slice(0, 20)}...`)
      }
      const pubkeyHex = (
        pubkey.startsWith("0x") ? pubkey : `0x${pubkey}`
      ) as `0x${string}`

      // ================================================================
      // Step 3: Deploy & configure LighterPayloadBuilder
      // ================================================================
      // Register under Lighter chainId (304) as primary.
      // ChangePubKey uses gatewayChainId (ETH mainnet=1) injected at deploy time.
      const registrationChainId = BigInt(lighterChainId)

      let payloadBuilderAddress = await allocator.read.payloadBuilders([
        registrationChainId,
        zeroAddress,
      ])

      if (payloadBuilderAddress === zeroAddress) {
        console.log("PayloadBuilder not set, deploying a new one...")
        const payloadBuilderContract = await viem.deployContract(
          "LighterPayloadBuilder",
          [
            allocatorAddress,
            BigInt(fromAccountIndex),
            LIGHTER_GATEWAY,
            BigInt(ethMainnetChainId), // gatewayChainId for ChangePubKey EIP-155
          ]
        )
        payloadBuilderAddress = payloadBuilderContract.address
        console.log(
          `LighterPayloadBuilder deployed to: ${payloadBuilderAddress}`
        )

        const tx = await allocator.write.setPayloadBuilder([
          registrationChainId,
          zeroAddress,
          payloadBuilderAddress,
        ])
        await publicClient.waitForTransactionReceipt({ hash: tx })
      }
      console.log(`Payload builder: ${payloadBuilderAddress}`)

      const payloadBuilder = await viem.getContractAt(
        "LighterPayloadBuilder",
        payloadBuilderAddress
      )

      // Configure route types
      for (const rt of [fromRouteType, toRouteType]) {
        try {
          const tx = await payloadBuilder.write.setRouteTypeWhitelisted([
            BigInt(rt),
            true,
          ])
          await publicClient.waitForTransactionReceipt({ hash: tx })
        } catch (error: any) {
          if (!error.message.includes("NotRelayAllocatorOwner")) throw error
          // Swallow auth error — may already be set by the actual owner
        }
      }
      // Verify route types are actually set (regardless of who set them)
      for (const rt of [fromRouteType, toRouteType]) {
        const isValid = await payloadBuilder.read.routeTypeWhitelist([
          BigInt(rt),
        ])
        if (!isValid) {
          throw new Error(
            `Route type ${rt} not whitelisted — set it via the allocator owner before running this test`
          )
        }
      }
      console.log(`Route types ${fromRouteType} and ${toRouteType} whitelisted`)

      // Whitelist the API key on PayloadBuilder
      try {
        const tx = await payloadBuilder.write.setApiKeyWhitelisted([
          pubkeyHex,
          Number(apiKeyIndex),
          true,
        ])
        await publicClient.waitForTransactionReceipt({ hash: tx })
      } catch (error: any) {
        if (!error.message.includes("NotRelayAllocatorOwner")) throw error
        // Swallow auth error — may already be set by the actual owner
      }
      // Verify API key is actually whitelisted
      const apiKeyHash = keccak256(
        encodeAbiParameters(
          [{ type: "bytes" }, { type: "uint8" }],
          [pubkeyHex, Number(apiKeyIndex)]
        )
      )
      const apiKeyValid = await payloadBuilder.read.apiKeyWhitelist([
        apiKeyHash,
      ])
      if (!apiKeyValid) {
        throw new Error(
          `API key index=${apiKeyIndex} not whitelisted — set it via the allocator owner before running this test`
        )
      }
      console.log(
        `API key whitelisted: index=${apiKeyIndex}, pubkey=${pubkeyHex.slice(0, 20)}...`
      )

      // Grant withdrawer role
      await run("allocator:add-withdrawer", {
        account: owner,
        allocator: allocatorAddress,
      })

      // Check if ChangePubKey can be skipped (already registered)
      const acctIdx = Number(fromAccountIndex)
      const keyIdx = Number(apiKeyIndex)
      let skipChangePubKey = false
      try {
        const resp = (await lighterApi.getApiKeys(acctIdx, keyIdx)) as any
        const keys = resp?.api_keys || []
        if (keys.some((k: any) => k.api_key_index === keyIdx)) {
          console.log(
            `\nAPI key index=${keyIdx} already registered on Lighter, skipping ChangePubKey`
          )
          skipChangePubKey = true
        }
      } catch {
        // Not registered yet, proceed with ChangePubKey
      }

      // ================================================================
      // Step 4: ChangePubKey — register API key on-chain
      // ================================================================
      let cpkReceipt: any = null
      let ts: any
      if (!skipChangePubKey) {
        console.log("\n========== ChangePubKey: Register API Key ==========")

        // Create Ethereum client for ChangePubKey broadcast
        const ethClient = createPublicClient({ transport: http(ethRpcUrl) })

        // Fetch MPC address nonce + balance on Ethereum
        const [changePubKeyTxNonce, ethBalance, ethGasPrice] =
          await Promise.all([
            ethClient
              .getTransactionCount({ address: signerAddress })
              .then(BigInt),
            ethClient.getBalance({ address: signerAddress }),
            ethClient.getGasPrice(),
          ])
        const changePubKeyGasPrice = (ethGasPrice * 12n) / 10n // +20% buffer
        const changePubKeyGasLimit = 200000n

        console.log(
          `MPC address on Ethereum: nonce=${changePubKeyTxNonce}, balance=${formatEther(ethBalance)} ETH, gasPrice=${changePubKeyGasPrice / 1000000000n} gwei`
        )
        const estimatedCost = changePubKeyGasPrice * changePubKeyGasLimit
        const fundingTarget = estimatedCost * 2n // enough for ~2 ChangePubKey txs
        if (ethBalance < estimatedCost) {
          const deficit = fundingTarget - ethBalance
          console.log(
            `MPC address has insufficient ETH (${formatEther(ethBalance)}). Sending ${formatEther(deficit)} ETH...`
          )
          const adminEth = createWalletClient({
            account: privateKeyToAccount(deployerKey),
            chain: ethChain,
            transport: http(ethRpcUrl),
          })
          const fundTx = await adminEth.sendTransaction({
            account: adminEth.account,
            chain: ethChain,
            to: signerAddress,
            value: deficit,
          } as any)
          await ethClient.waitForTransactionReceipt({ hash: fundTx })
          console.log(`   Funded MPC: ${fundTx}`)
        }

        const changePubKeyData = encodeAbiParameters(
          [
            { type: "uint8" },
            { type: "bytes" },
            { type: "uint64" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
          ],
          [
            1, // actionType = ChangePubKey
            pubkeyHex,
            BigInt(apiKeyIndex),
            changePubKeyTxNonce,
            changePubKeyGasPrice,
            changePubKeyGasLimit,
          ]
        )

        await checkAndApproveWNEAR(hre, admin.account.address, allocatorAddress)

        const changePubKeyNonce = keccak256(
          `0x${Date.now().toString()}` as `0x${string}`
        )

        const changePubKeyRequestHash = await run("allocator:submit-withdraw", {
          allocator: allocatorAddress,
          amount: "0",
          chainId: registrationChainId.toString(),
          currency: "0", // not relevant for ChangePubKey
          data: changePubKeyData,
          depository: zeroAddress,
          nonce: changePubKeyNonce,
          receiver: "0", // not relevant for ChangePubKey
        })
        console.log(`ChangePubKey request hash: ${changePubKeyRequestHash}`)

        const changePubKeyPayload = await allocator.read.payloads([
          changePubKeyRequestHash,
        ])

        // Wait for timelock
        await wait(Number(delay))
        ts = await allocator.read.payloadTimestamps([changePubKeyRequestHash])
        while (new Date().getTime() < Number(ts) * 1000) {
          await wait(1)
        }

        await run("allocator:sign-payload", {
          allocator: allocatorAddress,
          amount: "0",
          chainId: registrationChainId.toString(),
          currency: "0",
          data: changePubKeyData,
          depository: zeroAddress,
          nonce: changePubKeyNonce,
          receiver: "0",
          wnear,
        })

        // Retrieve ChangePubKey signature
        const changePubKeyHash = await payloadBuilder.read.hashToSign([
          registrationChainId,
          zeroAddress,
          changePubKeyPayload,
          0,
        ])

        let changePubKeySigned = await allocator.read.signedPayloads([
          changePubKeyRequestHash,
          changePubKeyHash,
        ])
        for (let sigPoll = 0; changePubKeySigned === "0x"; sigPoll++) {
          if (sigPoll >= 300) {
            throw new Error(
              "Timed out waiting for ChangePubKey MPC signature (300s)"
            )
          }
          console.log("Waiting for ChangePubKey signature...")
          await wait(1)
          changePubKeySigned = await allocator.read.signedPayloads([
            changePubKeyRequestHash,
            changePubKeyHash,
          ])
        }

        const cpkSig = extractNearSignature(changePubKeySigned)

        // Decode inner ChangePubKeyTx to reconstruct the signed EVM transaction
        const [outerPayload] = decodeAbiParameters(
          LIGHTER_PAYLOAD_ABI,
          changePubKeyPayload
        ) as unknown as any[]
        if (outerPayload.actionType !== 1) {
          throw new Error(
            `ChangePubKey actionType mismatch: expected 1, got ${outerPayload.actionType}`
          )
        }
        const [changePubKeyTx] = decodeAbiParameters(
          CHANGE_PUB_KEY_TX_ABI,
          outerPayload.parameters
        ) as unknown as any[]

        // Verify: calldata encodes changePubKey(uint48,uint8,bytes) with correct args
        const changePubKeyAbi = parseAbi([
          "function changePubKey(uint48 accountIndex, uint8 apiKeyIndex, bytes pubKey)",
        ])
        const decoded = decodeFunctionData({
          abi: changePubKeyAbi,
          data: changePubKeyTx.data,
        })
        if (BigInt(decoded.args[0]) !== BigInt(fromAccountIndex)) {
          throw new Error(
            `ChangePubKey accountIndex mismatch: ${decoded.args[0]} !== ${fromAccountIndex}`
          )
        }
        if (BigInt(decoded.args[1]) !== BigInt(apiKeyIndex)) {
          throw new Error(
            `ChangePubKey apiKeyIndex mismatch: ${decoded.args[1]} !== ${apiKeyIndex}`
          )
        }
        if (
          (decoded.args[2] as string).toLowerCase() !== pubkeyHex.toLowerCase()
        ) {
          throw new Error(
            `ChangePubKey pubkey mismatch: ${decoded.args[2]} !== ${pubkeyHex}`
          )
        }
        // Verify tx params match inputs
        if (changePubKeyTx.txNonce !== changePubKeyTxNonce) {
          throw new Error(
            `ChangePubKey txNonce mismatch: ${changePubKeyTx.txNonce} !== ${changePubKeyTxNonce}`
          )
        }
        if (changePubKeyTx.gasPrice !== changePubKeyGasPrice) {
          throw new Error(
            `ChangePubKey gasPrice mismatch: ${changePubKeyTx.gasPrice} !== ${changePubKeyGasPrice}`
          )
        }
        if (changePubKeyTx.gasLimit !== changePubKeyGasLimit) {
          throw new Error(
            `ChangePubKey gasLimit mismatch: ${changePubKeyTx.gasLimit} !== ${changePubKeyGasLimit}`
          )
        }
        console.log(
          "✅ ChangePubKey payload verified (actionType, calldata args, tx params)"
        )

        // Verify: reconstruct the unsigned tx hash and compare
        const serialized = serializeTransaction({
          chainId: Number(ethMainnetChainId),
          data: changePubKeyTx.data,
          gas: changePubKeyTx.gasLimit,
          gasPrice: changePubKeyTx.gasPrice,
          nonce: Number(changePubKeyTx.txNonce),
          to: LIGHTER_GATEWAY as `0x${string}`,
          type: "legacy",
          value: 0n,
        })
        const expectedHash = keccak256(serialized)

        if (changePubKeyHash !== expectedHash) {
          throw new Error(
            `ChangePubKey hash mismatch: contract=${changePubKeyHash} expected=${expectedHash}`
          )
        }

        // Build the signed transaction for broadcast
        const signedTx = serializeTransaction(
          {
            chainId: Number(ethMainnetChainId),
            data: changePubKeyTx.data,
            gas: changePubKeyTx.gasLimit,
            gasPrice: changePubKeyTx.gasPrice,
            nonce: Number(changePubKeyTx.txNonce),
            to: LIGHTER_GATEWAY as `0x${string}`,
            type: "legacy",
            value: 0n,
          },
          {
            r: `0x${cpkSig.r}` as `0x${string}`,
            s: `0x${cpkSig.s}` as `0x${string}`,
            v: BigInt(cpkSig.v),
          }
        )

        console.log("✅ ChangePubKey signature verified")

        // Broadcast ChangePubKey tx to Ethereum
        console.log("📡 Broadcasting ChangePubKey tx to Ethereum...")
        console.log(`   From: ${signerAddress}`)
        console.log(`   To: ${LIGHTER_GATEWAY}`)
        const cpkTxHash = await ethClient.sendRawTransaction({
          serializedTransaction: signedTx,
        })
        console.log(`   Tx hash: ${cpkTxHash}`)
        console.log("   Waiting for confirmation...")
        cpkReceipt = await ethClient.waitForTransactionReceipt({
          hash: cpkTxHash,
        })
        if (cpkReceipt.status !== "success") {
          throw new Error(`ChangePubKey tx reverted: ${cpkTxHash}`)
        }
        console.log(
          `✅ ChangePubKey confirmed in block ${cpkReceipt.blockNumber}`
        )

        // Poll Lighter API until changePubKey is recognized
        console.log("Waiting for Lighter to process changePubKey...")
        for (let i = 0; i < 120; i++) {
          try {
            const resp = (await lighterApi.getApiKeys(acctIdx, keyIdx)) as any
            const keys = resp?.api_keys || []
            if (keys.some((k: any) => k.api_key_index === keyIdx)) {
              console.log(
                `✅ Lighter recognized API key (index=${keyIdx}) after ${i + 1}s`
              )
              break
            }
          } catch {
            // not ready yet
          }
          if (i === 119) {
            throw new Error(
              "Timed out waiting for Lighter to process changePubKey (120s)"
            )
          }
          await wait(1)
        }
      } // end !skipChangePubKey

      // ================================================================
      // Step 5: Transfer — MPC signs personal_sign L1 message
      // ================================================================
      console.log("\n========== Transfer: Withdraw via Lighter API ==========")

      // Initialize SignerClient for transfer operations (fee query + signing + submission)
      // Uses the same high-level client as the solver, which handles WASM internals correctly
      let signerClient: InstanceType<typeof SignerClient> | null = null
      if (apiKeyPrivateKey) {
        signerClient = new SignerClient({
          accountIndex: Number(fromAccountIndex),
          apiKeyIndex: Number(apiKeyIndex),
          privateKey: apiKeyPrivateKey.startsWith("0x")
            ? apiKeyPrivateKey.slice(2)
            : `${apiKeyPrivateKey}`,
          url: lighterApiUrl,
        })
        await signerClient.initialize()
        await signerClient.ensureWasmClient()

        // Query transfer fee from Lighter API if default is 0
        if (usdcFee === "0") {
          try {
            const authToken = await signerClient.createAuthToken()
            const feeClient = new ApiClient({ host: lighterApiUrl })
            const feeResp = await feeClient.get(
              "/api/v1/transferFeeInfo",
              {
                account_index: Number(fromAccountIndex),
                to_account_index: Number(recipient),
              },
              {
                headers: { Authorization: authToken },
              }
            )
            usdcFee = String((feeResp as any).data.transfer_fee_usdc)
            console.log(`Transfer fee from API: ${usdcFee}`)
          } catch (e: any) {
            console.log(
              `⚠️ Failed to query transfer fee: ${e.message}, using usdcFee=${usdcFee}`
            )
          }
        }
      }

      // Get next nonce from Lighter API (must match what the API expects)
      const transactionApi = new TransactionApi(
        new ApiClient({ host: lighterApiUrl })
      )
      const nextNonce = await transactionApi.getNextNonce(
        Number(fromAccountIndex),
        Number(apiKeyIndex)
      )
      const transferNonce = BigInt(nextNonce.nonce)
      console.log(`Transfer nonce from API: ${transferNonce}`)
      const memo = keccak256(`0x${Date.now().toString(16)}` as `0x${string}`)

      const transferData = encodeAbiParameters(
        [
          { type: "uint8" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "bytes32" },
        ],
        [
          0, // actionType = Transfer
          transferNonce,
          BigInt(fromRouteType),
          BigInt(toRouteType),
          BigInt(apiKeyIndex),
          BigInt(usdcFee),
          memo as `0x${string}`,
        ]
      )

      await checkAndApproveWNEAR(hre, owner, allocatorAddress)

      const transferRequestNonce = keccak256(
        `0x${(Date.now() + 1).toString()}` as `0x${string}`
      )

      const transferRequestHash = await run("allocator:submit-withdraw", {
        allocator: allocatorAddress,
        amount,
        chainId: registrationChainId.toString(),
        currency: assetIndex,
        data: transferData,
        depository: zeroAddress,
        nonce: transferRequestNonce,
        receiver: recipient,
      })
      console.log(`Transfer request hash: ${transferRequestHash}`)

      const transferPayload = await allocator.read.payloads([
        transferRequestHash,
      ])

      // Verify: decode payload and check all fields match inputs
      const [transferOuterPayload] = decodeAbiParameters(
        LIGHTER_PAYLOAD_ABI,
        transferPayload
      ) as unknown as any[]
      if (transferOuterPayload.actionType !== 0) {
        throw new Error(
          `Transfer actionType mismatch: expected 0, got ${transferOuterPayload.actionType}`
        )
      }
      const [decodedTransfer] = decodeAbiParameters(
        LIGHTER_TRANSFER_REQUEST_ABI,
        transferOuterPayload.parameters
      ) as unknown as any[]
      const transferChecks: [string, bigint, bigint][] = [
        ["nonce", decodedTransfer.nonce, transferNonce],
        [
          "fromAccountIndex",
          decodedTransfer.fromAccountIndex,
          BigInt(fromAccountIndex),
        ],
        ["fromRouteType", decodedTransfer.fromRouteType, BigInt(fromRouteType)],
        ["apiKeyIndex", decodedTransfer.apiKeyIndex, BigInt(apiKeyIndex)],
        ["toAccountIndex", decodedTransfer.toAccountIndex, BigInt(recipient)],
        ["toRouteType", decodedTransfer.toRouteType, BigInt(toRouteType)],
        ["assetIndex", decodedTransfer.assetIndex, BigInt(assetIndex)],
        ["amount", decodedTransfer.amount, BigInt(amount)],
        ["usdcFee", decodedTransfer.usdcFee, BigInt(usdcFee)],
        [
          "lighterChainId",
          decodedTransfer.lighterChainId,
          BigInt(lighterChainId),
        ],
      ]
      for (const [name, actual, expected] of transferChecks) {
        if (actual !== expected) {
          throw new Error(
            `Transfer payload field ${name} mismatch: ${actual} !== ${expected}`
          )
        }
      }
      if (decodedTransfer.memo !== (memo as `0x${string}`)) {
        throw new Error(
          `Transfer payload memo mismatch: ${decodedTransfer.memo} !== ${memo}`
        )
      }
      console.log("✅ Transfer payload fields verified (all 11 fields match)")

      // Wait for timelock
      await wait(Number(delay))
      ts = await allocator.read.payloadTimestamps([transferRequestHash])
      while (new Date().getTime() < Number(ts) * 1000) {
        await wait(1)
      }

      await run("allocator:sign-payload", {
        allocator: allocatorAddress,
        amount,
        chainId: registrationChainId.toString(),
        currency: assetIndex,
        data: transferData,
        depository: zeroAddress,
        nonce: transferRequestNonce,
        receiver: recipient,
        wnear,
      })

      // Retrieve Transfer signature (personal_sign)
      const transferHash = await payloadBuilder.read.hashToSign([
        registrationChainId,
        zeroAddress,
        transferPayload,
        0,
      ])

      let transferSigned = await allocator.read.signedPayloads([
        transferRequestHash,
        transferHash,
      ])
      for (let sigPoll = 0; transferSigned === "0x"; sigPoll++) {
        if (sigPoll >= 300) {
          throw new Error("Timed out waiting for Transfer MPC signature (300s)")
        }
        console.log("Waiting for Transfer signature...")
        await wait(1)
        transferSigned = await allocator.read.signedPayloads([
          transferRequestHash,
          transferHash,
        ])
      }

      const txSig = extractNearSignature(transferSigned)
      const l1Sig =
        `0x${txSig.r}${txSig.s}${txSig.v.toString(16).padStart(2, "0")}` as `0x${string}`

      // Verify personal_sign recovery
      const l1Message = buildTransferL1Message({
        amount: BigInt(amount),
        apiKeyIndex: BigInt(apiKeyIndex),
        assetIndex: BigInt(assetIndex),
        fromAccountIndex: BigInt(fromAccountIndex),
        fromRouteType: BigInt(fromRouteType),
        lighterChainId: BigInt(lighterChainId),
        memo: (memo as string).slice(2),
        nonce: transferNonce,
        toAccountIndex: BigInt(recipient),
        toRouteType: BigInt(toRouteType),
        usdcFee: BigInt(usdcFee),
      })

      const recoveredAddress = await recoverMessageAddress({
        message: l1Message,
        signature: l1Sig,
      })

      if (signerAddress !== recoveredAddress) {
        throw new Error(
          `Transfer sig recovery mismatch: ${signerAddress} !== ${recoveredAddress}`
        )
      }

      console.log("✅ Transfer L1Sig verified (personal_sign)")
      console.log(`   Signer: ${signerAddress}`)

      // ================================================================
      // Step 6: Submit Transfer to Lighter API
      // ================================================================
      console.log("\n========== Submit Transfer to Lighter API ==========")

      let transferTxHash: string | null = null
      if (!signerClient) {
        console.log(
          "⚠️ No API key private key available — cannot submit to Lighter API"
        )
        console.log(
          "   Provide LIGHTER_API_KEY_PRIVATE env var or omit --pubkey to auto-generate"
        )
      } else {
        // Use SignerClient.transfer() with a mock ethSigner that returns our MPC L1Sig
        // This follows the exact same code path as the solver
        // memo must keep 0x prefix — SDK uses startsWith('0x') to decide hex vs UTF-8
        const mockEthSigner = { signMessage: async (_msg: any) => l1Sig }

        console.log(
          "Submitting transfer via SignerClient (mock ethSigner → MPC L1Sig)..."
        )

        const [, txHash, transferError] = await signerClient.transfer({
          amount: Number(amount),
          assetIndex: Number(assetIndex),
          ethSigner: mockEthSigner as any,
          fromRouteType: Number(fromRouteType),
          memo: memo as string,
          nonce: Number(transferNonce),
          toAccountIndex: Number(recipient),
          toRouteType: Number(toRouteType),
          usdcFee: Number(usdcFee),
        })

        if (transferError) {
          throw new Error(`Transfer submission failed: ${transferError}`)
        }

        transferTxHash = txHash || null
        console.log("✅ Transfer submitted to Lighter API")
        console.log(`   Tx hash: ${transferTxHash}`)

        // Poll for transaction confirmation
        if (transferTxHash) {
          console.log("Waiting for transaction confirmation...")
          for (let i = 0; i < 120; i++) {
            try {
              const txStatus = await transactionApi.getTransaction({
                by: "hash",
                value: transferTxHash,
              })
              if (txStatus.executed_at || txStatus.verified_at) {
                console.log(
                  `✅ Transfer confirmed after ${i + 1}s (status=${txStatus.status})`
                )
                break
              }
              if (txStatus.status === "failed") {
                throw new Error(
                  `Transfer failed on Lighter: ${JSON.stringify(txStatus)}`
                )
              }
            } catch (e: any) {
              if (e.message?.includes("Transfer failed")) throw e
              // not ready yet
            }
            if (i === 119) {
              throw new Error(
                "Timed out waiting for Transfer confirmation on Lighter (120s)"
              )
            }
            await wait(1)
          }
        }
      }

      // ================================================================
      // Summary
      // ================================================================
      console.log("\n========== Summary ==========")
      if (cpkReceipt) {
        console.log(
          `✅ ChangePubKey: broadcast confirmed (block ${cpkReceipt.blockNumber})`
        )
      } else {
        console.log("✅ ChangePubKey: already registered (skipped)")
      }
      if (transferTxHash) {
        console.log("✅ Transfer: submitted and confirmed")
        console.log(`   Tx: ${transferTxHash}`)
        console.log(
          `   Explorer: https://lighter.exchange/explorer/logs/${transferTxHash}`
        )
      } else if (!apiKeyPrivateKey) {
        console.log(
          "✅ Transfer: L1Sig signed, ready for Lighter API submission"
        )
      } else {
        console.log("✅ Transfer: submitted (no tx hash returned)")
      }
      if (apiKeyPrivateKey) {
        console.log("\n🔑 API key pair (store securely for solver config):")
        console.log(`   lvmApiKey=${apiKeyPrivateKey}:${apiKeyIndex}`)
      }
    }
  )
