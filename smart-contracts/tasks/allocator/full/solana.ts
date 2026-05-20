import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
import { task } from "hardhat/config"
import nacl from "tweetnacl"
import { fromHex, parseEventLogs, zeroAddress } from "viem"
import { checkAndApproveWNEAR } from "../../../lib/aurora"
import { derivePublicKey } from "@relay-settlement/multisig-tools/crypto/near"
import { base58ToBytes32, decodeDepositoryRequest } from "../../../lib/solana"
import { wait } from "@relay-settlement/multisig-tools/crypto/wait"

const DEFAULT_DELAY = "1"

task(
  "full:solana",
  "Deploy the Allocator contract, initializes it, sets a payload builder, submits a withdraw request, triggers a signature, and verifies the payload"
)
  .addParam("owner", "The address of the owner")
  .addOptionalParam("chainId", "The chain ID on which we withdraw")
  .addOptionalParam("depository", "The address of the depository contract")
  .addOptionalParam("signer", "The address of the signer")
  .addOptionalParam("wnear", "The address of the wNEAR token")
  .addOptionalParam("amount", "The amount to withdraw from the depository", "1")
  .addOptionalParam(
    "recipient",
    "The address that will receive the withdrawn amount",
    "1"
  )
  .addOptionalParam(
    "currency",
    "The currency to withdraw from the depository",
    zeroAddress
  )
  .addOptionalParam("delay", "The delay in seconds", DEFAULT_DELAY)
  .addOptionalParam("payloadType", "The Payload builder type", "ethereum-vm")
  .setAction(
    async (
      {
        owner,
        signer,
        wnear,
        delay,
        chainId = 1115111n,
        depository: depositoryAddress,
        amount,
        currency,
        recipient,
      },
      hre
    ) => {
      const { viem, run } = hre
      // recompile contracts
      await run("compile")

      const publicClient = await viem.getPublicClient()

      const allocatorAddress = await run("deploy:allocator", {
        delay,
        owner,
        signer,
        wnear,
      })

      const allocator = await viem.getContractAt(
        "RelayAllocator",
        allocatorAddress
      )
      let payloadBuilderAddress = await allocator.read.payloadBuilders([
        chainId,
        depositoryAddress,
      ])
      if (payloadBuilderAddress === zeroAddress) {
        console.log("PayloadBuilder not set, deploying a new one...")

        payloadBuilderAddress = await run("deploy:payload-builder", {
          payloadBuilder: "SolanaVmPayloadBuilder",
        })

        const tx = await allocator.write.setPayloadBuilder([
          chainId,
          depositoryAddress,
          payloadBuilderAddress,
        ])
        await publicClient.waitForTransactionReceipt({
          hash: tx,
        })
      }
      console.log(`Payload builder: ${payloadBuilderAddress}`)

      await run("allocator:add-withdrawer", {
        account: owner,
        allocator: allocatorAddress,
      })

      if (!recipient) {
        const [recipientSigner] = await viem.getWalletClients()
        recipient = recipientSigner.account.address
      }

      // Check and approve wNEAR allowance
      await checkAndApproveWNEAR(hre, owner, allocatorAddress)
      const withdrawRequestHash = await run("allocator:submit-withdraw", {
        allocator: allocatorAddress,
        amount,
        chainId: chainId.toString(),
        currency: currency === zeroAddress ? "" : base58ToBytes32(currency),
        depository: depositoryAddress,
        receiver: base58ToBytes32(recipient),
        wnear,
      })

      // Get the payload
      const payload = await allocator.read.unsignedPayloads([
        withdrawRequestHash,
      ])

      // decode payload
      const message = await decodeDepositoryRequest(payload)
      console.log(message)

      // Trigger a signature
      await wait(delay)

      await run("allocator:sign-payload", {
        allocator: allocatorAddress,
        chainId: chainId.toString(),
        depository: depositoryAddress,
        withdrawRequestHash,
        wnear,
      })

      // Verify that the signatures match
      const payloadBuilder = await viem.getContractAt(
        "EthereumVmPayloadBuilder",
        payloadBuilderAddress
      )
      const payloadHashes = await payloadBuilder.read.hashesToSign([
        chainId,
        depositoryAddress,
        payload,
      ])

      // Wait 10 seconds to "wait" for the signature to arrive
      let signedPayload = await allocator.read.signedPayloads([
        withdrawRequestHash,
        payloadHashes[0],
      ])
      while (signedPayload === "0x") {
        console.log(signedPayload)
        console.log("Waiting for signed payload...")
        await wait(1)
        signedPayload = await allocator.read.signedPayloads([
          withdrawRequestHash,
          payloadHashes[0],
        ])
      }
      const jsonSignature = JSON.parse(fromHex(signedPayload, "string"))

      // Convert the signature array to Uint8Array
      const signatureBytes = new Uint8Array(jsonSignature.signature)

      const derivationPath = allocatorAddress.toLowerCase()
      // remove 0x for aurora address
      const predecessor = `${allocatorAddress.substring(2).toLowerCase()}.aurora`
      const domainId = 1

      // Get the public key from the NEAR contract
      const { publicKey: allocatorPublicKey } = await derivePublicKey(
        derivationPath,
        predecessor,
        Number(domainId)
      )

      // Verify the signature
      const isValid = nacl.sign.detached.verify(
        Buffer.from(payloadHashes[0].replace("0x", ""), "hex"),
        signatureBytes,
        bs58.decode(allocatorPublicKey)
      )

      console.log("Signature verification result:", isValid)
      console.log("Allocator pub key:", allocatorPublicKey)
    }
  )

task("solana:recover", "")
  .addParam(
    "txHash",
    "The transaction hash containing PayloadWithdrawSigned event"
  )
  .addParam("allocator", "The address of the allocator contract")
  .setAction(async ({ txHash, allocator }, hre) => {
    const { viem } = hre
    const publicClient = await viem.getPublicClient()

    const derivationPath = allocator.toLowerCase() // remove 0x
    const predecessor = `${allocator.substring(2).toLowerCase()}.aurora`
    const domainId = 1

    // Get allocator contract instance
    const allocatorContract = await viem.getContractAt(
      "RelayAllocator",
      allocator
    )

    // Get transaction receipt
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    if (!receipt) {
      throw new Error(`Transaction ${txHash} not found`)
    }

    // Find PayloadWithdrawSigned event
    const [payloadWithdrawSignedEvent] = parseEventLogs({
      abi: allocatorContract.abi,
      eventName: "PayloadWithdrawSigned",
      logs: receipt.logs,
    })
    if (!payloadWithdrawSignedEvent) {
      throw new Error("PayloadWithdrawSigned event not found in transaction")
    }

    const jsonSignature = JSON.parse(
      fromHex(payloadWithdrawSignedEvent.args.signedPayload, "string")
    )

    // Get the public key from the NEAR contract
    const { publicKey: signerPublicKey } = await derivePublicKey(
      derivationPath,
      predecessor,
      Number(domainId)
    )

    const isValid = nacl.sign.detached.verify(
      Buffer.from(
        payloadWithdrawSignedEvent.args.hashToSign.replace("0x", ""),
        "hex"
      ),
      new Uint8Array(jsonSignature.signature),
      bs58.decode(signerPublicKey)
    )

    console.log("Signature verification result:", isValid)
    console.log("Allocator public key:", signerPublicKey)
  })
