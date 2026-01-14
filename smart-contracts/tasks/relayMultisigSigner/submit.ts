import { task } from "hardhat/config"
import { checksumAddress } from "viem"
import { createSafeClient } from "@safe-global/sdk-starter-kit"
import { createTransactionBundle } from "./utils"
import { networks } from "@relay-protocol/settlement-networks"

task(
  "relay-multisig-signer:submit",
  "Submits transactions from a transactions manifest file to a Gnosis Safe."
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
      let resolvedAddress = relayMultisigSignerAddress
      if (!resolvedAddress) {
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
        resolvedAddress = network.contracts.prod.multisigSigner
        console.log(
          `Using multisigSigner address from network config: ${resolvedAddress}`
        )
      }

      const relayMultisigSigner = await hre.viem.getContractAt(
        "RelayMultisigSigner",
        resolvedAddress
      )

      // TODO: should we handle this if the owner is _not_ a SAFE? (things will fail later).
      const safeMultisigAddress = await relayMultisigSigner.read.owner()

      const safe = await createSafeClient({
        apiKey: process.env.SAFE_API_KEY!,
        provider: hre.network.config.url,
        safeAddress: safeMultisigAddress,
        signer: process.env.DEPLOYER_PRIVATE_KEY,
      })

      const transactionBundle = await createTransactionBundle(
        transactionsPath,
        relayMultisigSigner
      )
      const publicClient = await hre.viem.getPublicClient()
      for (let i = 0; i < transactionBundle.length; i++) {
        const action = transactionBundle[i]
        // Let's simulate all!
        await publicClient.estimateGas({
          account: safeMultisigAddress, // REQUIRED so the node simulates as your sender
          data: action.data,
          to: action.to,
          value: BigInt(action.value),
        })
      }

      const nonce = await safe.getNonce()
      console.log("📦 Submitting hashes to be signed")

      // Create a Safe transaction
      const safeTransaction = await safe.protocolKit.createTransaction({
        options: {
          nonce,
        },
        transactions: transactionBundle,
      })

      const safeTxHash =
        await safe.protocolKit.getTransactionHash(safeTransaction)
      const signature = await safe.protocolKit.signHash(safeTxHash)
      // Submit to the safe so it can be signed:
      console.log(`🗳️  Proposing transaction ${nonce} to multisig`)

      await safe.apiKit.proposeTransaction({
        safeAddress: checksumAddress(safeMultisigAddress),
        safeTransactionData: safeTransaction.data,
        safeTxHash: safeTxHash,
        senderAddress: checksumAddress(user.account.address),
        senderSignature: signature.data,
      })
    }
  )
