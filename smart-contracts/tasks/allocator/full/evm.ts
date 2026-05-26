import { task } from "hardhat/config"
import { keccak256, recoverTypedDataAddress, zeroAddress } from "viem"
import {
  derivePublicKey,
  extractNearSignature,
} from "@relay-settlement/multisig-tools/crypto/near"
import { wait } from "@relay-settlement/multisig-tools/crypto/wait"
import { publicKeyToAddress } from "viem/utils"
import { base58 } from "@scure/base"
import { decodeCallRequest } from "@relay-settlement/multisig-tools/crypto/evm"

task(
  "full:evm",
  "Deploy the Allocator contract, initializes it, sets a payload builder, submits a withdraw request, triggers a signature, and verifies the payload"
)
  .addOptionalParam("owner", "The address of the owner")
  .addParam("chainId", "The chain ID on which we withdraw")
  .addParam("depository", "The address of the depository contract")
  .addOptionalParam(
    "allocator",
    "The address of the allocator contract if it was already deployed"
  )
  .addOptionalParam("signer", "The address of the signer")
  .addOptionalParam("wnear", "The address of the wNEAR token")
  .addOptionalParam("amount", "The amount to withdraw from the depository", "1")
  .addOptionalParam(
    "currency",
    "The currency to withdraw from the depository",
    zeroAddress
  )
  .setAction(
    async (
      {
        owner,
        signer: _signer,
        wnear,
        chainId,
        depository: depositoryAddress,
        allocator: allocatorAddress,
        amount,
        currency,
      },
      { viem, run }
    ) => {
      const [admin] = await viem.getWalletClients()

      // recompile contracts
      await run("compile")

      const publicClient = await viem.getPublicClient()

      if (!allocatorAddress) {
        throw new Error(
          "--allocator is required. Deploy one first with " +
            "`HUB=<hub> ORACLE=<oracle> yarn deploy:allocator` and pass " +
            "--allocator <address>."
        )
      }

      const allocator = await viem.getContractAt(
        "RelayAllocator",
        allocatorAddress
      )
      const delay = await allocator.read.delay()

      let payloadBuilderAddress = await allocator.read.payloadBuilders([
        chainId,
        depositoryAddress,
      ])

      if (payloadBuilderAddress === zeroAddress) {
        console.log("PayloadBuilder not set, deploying a new one...")

        payloadBuilderAddress = await run("deploy:evm-payload-builder")

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

      if (!owner) {
        owner = admin.account.address
      }
      await run("allocator:add-withdrawer", {
        account: owner,
        allocator: allocatorAddress,
      })

      const nonce = keccak256(`0x${new Date().getTime().toString()}`)

      // Submit a withdraw request to the Allocator for an EVM chain!
      const withdrawRequestHash = await run("allocator:submit-withdraw", {
        allocator: allocatorAddress,
        amount,
        chainId,
        currency,
        depository: depositoryAddress,
        nonce,
        wnear,
      })

      // Get the payload
      const payload = await allocator.read.payloads([withdrawRequestHash])

      // Trigger a signature
      await wait(Number(delay))
      const timestamp = await allocator.read.payloadTimestamps([
        withdrawRequestHash,
      ])
      while (new Date().getTime() < Number(timestamp) * 1000) {
        await wait(1)
      }

      await run("allocator:sign-payload", {
        allocator: allocatorAddress,
        amount,
        chainId,
        currency,
        depository: depositoryAddress,
        nonce,
        withdrawRequestHash,
        wnear,
      })

      // Verify that the signatures match
      // get the payload hashes that are to be signed
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
        console.log("Waiting for signed payload...")
        await wait(1)
        signedPayload = await allocator.read.signedPayloads([
          withdrawRequestHash,
          payloadHashes[0],
        ])
      }

      const { r, s, v } = extractNearSignature(signedPayload)

      const signature =
        `0x${r}${s}${v.toString(16).padStart(2, "0")}` as `0x${string}`

      // Create the typed data structure
      const types = {
        Call: [
          { name: "to", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
          { name: "allowFailure", type: "bool" },
        ],
        CallRequest: [
          { name: "calls", type: "Call[]" },
          { name: "nonce", type: "uint256" },
          { name: "expiration", type: "uint256" },
        ],
      }

      const derivationPath = allocatorAddress.toLowerCase()
      // remove 0x for aurora address
      const predecessor = `${allocatorAddress.substring(2).toLowerCase()}.aurora`
      const domainId = 0 // 1 for Eddsa

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

      const request = decodeCallRequest(payload)

      // EIP-712 verification
      const recoveredFromTypedData = await recoverTypedDataAddress({
        domain: {
          chainId: Number(chainId),
          name: await payloadBuilder.read.SIGNING_DOMAIN(),
          verifyingContract: depositoryAddress,
          version: await payloadBuilder.read.SIGNATURE_VERSION(),
        },
        message: request,
        primaryType: "CallRequest",
        signature,
        types,
      })

      if (signerAddress !== recoveredFromTypedData) {
        throw new Error(
          `Recovered addresses do not match: ${signerAddress} !== ${recoveredFromTypedData}`
        )
      }
      console.log(
        "🔍 Recovered address (make sure it is the allocator on the depository contract):",
        signerAddress
      )
      console.log(
        "🔍 Recovered public key which can be used to compute addresses on all chains with the same curve:",
        allocatorPublicKey
      )
      console.log("📡 Transaction data to submit to the Depository contract:")
      console.log({
        payload: safeStringify(request),
        signature,
      })
    }
  )

const safeStringify = (obj: any) =>
  JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v))
