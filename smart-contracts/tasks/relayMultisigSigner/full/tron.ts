import { task } from "hardhat/config"
import networks from "@relay-settlement/networks"
import { checkAndApproveWNEAR } from "../../../lib/aurora"
import { derivePublicKey } from "../../../lib/near"
import { computeEvmAddress } from "../../../lib/signer"
import { loadTransactions } from "../utils"
import { buildTronTransaction } from "../utils"
import { executeTronTransaction } from "../execute-transactions"
import { wait } from "../../../lib/wait"
import { parseUnits, encodePacked } from "viem"
import * as tronweb from "tronweb"

/**
 * Convert ECDSA public key (hex string) to Tron address
 * @param publicKeyHex - ECDSA public key in hex format (with or without 0x prefix)
 * @returns Tron address (base58 format starting with T)
 */
function publicKeyToTronAddress(publicKeyRaw: string): string {
  const signerAddressEvm = computeEvmAddress(publicKeyRaw)
  // Take last 20 bytes
  const addressHex = signerAddressEvm.slice(-40)

  // Add Tron prefix (0x41 for mainnet/testnet)
  const tronAddressHex = `41${addressHex}`

  // Convert to base58 using TronWeb
  const tronAddress = tronweb.TronWeb.address.fromHex(tronAddressHex)
  return tronAddress
}

task(
  "full:relay-multisig-signer:tron",
  "Deploy and test RelayMultisigSigner with Tron transactions"
)
  .addParam("transactionFile", "Path to Tron transaction JSON file")
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

      // Get derived Tron address from ECDSA public key
      const derivationPath = relayMultisigSignerAddress.toLowerCase()
      const predecessor = `${relayMultisigSignerAddress.substring(2).toLowerCase()}.aurora`
      const { publicKey: ecdsaPublicKey } = await derivePublicKey(
        derivationPath,
        predecessor,
        0
      )

      const tronAddress = publicKeyToTronAddress(ecdsaPublicKey)
      console.log(`Tron signer: ${tronAddress}`)

      // Load and update transactions
      const transactions = loadTransactions(transactionFile)

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
        if (tx.family === "tron-vm") {
          // Build transaction once and cache the header info
          const { hashesToSign, transaction: builtTx } =
            await buildTronTransaction(tx)
          const hashToSign = hashesToSign[0]

          // Save the header info back to tx so second build will use same values
          tx.refBlockBytes = builtTx.raw_data.ref_block_bytes
          tx.refBlockHash = builtTx.raw_data.ref_block_hash
          tx.timestamp = builtTx.raw_data.timestamp
          tx.expiration = builtTx.raw_data.expiration

          console.log(`Approving signature: ${hashToSign}`)
          const approveTx =
            await relayMultisigSignerContract.write.approveSignature([
              encodePacked(["bytes32"], [hashToSign as `0x${string}`]),
              "Ecdsa",
            ])
          await publicClient.waitForTransactionReceipt({
            hash: approveTx,
          })
          await wait(10)
          // Execute (will rebuild using cached header info)
          await executeTronTransaction(tx, relayMultisigSignerAddress, hre)
        }
      }

      return relayMultisigSignerAddress
    }
  )
