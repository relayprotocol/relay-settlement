import { task } from "hardhat/config"
import networks from "@relay-protocol/settlement-networks"
import { checkAndApproveWNEAR } from "../../../lib/aurora"
import { derivePublicKey } from "../../../lib/near"
import { loadTransactions } from "../utils"
import { PublicKey } from "@solana/web3.js"
import { buildSolanaTransaction } from "../utils"
import { executeSolanaTransaction } from "../execute-transactions"
import { wait } from "../../../lib/wait"
import { parseUnits } from "viem"

task(
  "full:relay-multisig-signer:solana",
  "Deploy and test RelayMultisigSigner with Solana transactions"
)
  .addParam("transactionFile", "Path to Solana transaction JSON file")
  .addOptionalParam(
    "relayMultisigSigner",
    "Existing RelayMultisigSigner address"
  )
  .addOptionalParam("owner", "Owner address")
  .addOptionalParam("wnear", "wNEAR token address")
  .setAction(
    async ({ relayMultisigSigner, owner, wnear, transactionFile }, hre) => {
      const { run, network } = hre

      await run("compile")

      let relayMultisigSignerAddress: string

      if (relayMultisigSigner) {
        relayMultisigSignerAddress = relayMultisigSigner
        console.log(
          `Using existing RelayMultisigSigner: ${relayMultisigSignerAddress}`
        )
      } else {
        const { chainId } = network.config as { chainId: number }
        const networkConfig = networks[chainId.toString()]

        if (!wnear && networkConfig?.assets?.wNEAR) {
          wnear = networkConfig.assets.wNEAR
        }

        if (!owner) {
          const [defaultOwner] = await hre.viem.getWalletClients()
          owner = defaultOwner.account.address
        }

        relayMultisigSignerAddress = await run(
          "deploy:relay-multisigs-signer",
          {
            multisig: owner,
            wnear,
          }
        )
      }

      // Get derived Solana public key
      const derivationPath = relayMultisigSignerAddress.toLowerCase()
      const predecessor = `${relayMultisigSignerAddress.substring(2).toLowerCase()}.aurora`
      const { publicKey: solanaPublicKeyRaw } = await derivePublicKey(
        derivationPath,
        predecessor,
        1
      )
      const solanaPublicKey = new PublicKey(solanaPublicKeyRaw)

      console.log(`Solana signer: ${solanaPublicKey.toBase58()}`)

      // Load and update transactions
      const transactions = loadTransactions(transactionFile)
      transactions.forEach((tx) => {
        if (tx.family === "solana-vm") {
          tx.from = solanaPublicKey.toBase58()
        }
      })

      // Get contract instance and approve + execute directly
      const relayMultisigSignerContract = await hre.viem.getContractAt(
        "RelayMultisigSigner",
        relayMultisigSignerAddress
      )

      const publicClient = await hre.viem.getPublicClient()

      // Approve and execute each transaction
      const allowance = parseUnits("2", 24)
      await checkAndApproveWNEAR(
        hre,
        owner,
        relayMultisigSignerAddress,
        allowance
      )

      await wait(2)

      for (const tx of transactions) {
        if (tx.family === "solana-vm") {
          const { hashesToSign } = await buildSolanaTransaction(tx)
          const hashToSign = hashesToSign[0]

          console.log(`Approving signature: ${hashToSign}`)

          // Approve
          const approveTx =
            await relayMultisigSignerContract.write.approveSignature([
              hashToSign,
              "Eddsa",
            ])
          await publicClient.waitForTransactionReceipt({ hash: approveTx })
          console.log("Signature approved")
          await wait(2)
          // Execute
          await executeSolanaTransaction(tx, relayMultisigSignerAddress, hre)
        }
      }

      return relayMultisigSignerAddress
    }
  )
