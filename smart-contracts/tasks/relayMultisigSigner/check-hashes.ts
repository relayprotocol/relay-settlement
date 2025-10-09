import { task } from "hardhat/config"
import { checksumAddress } from "viem"
import {
  getPendingSafeTxActionsByNonce,
  createSafeClientWithConfig,
} from "../helpers/safe"
import { createTransactionBundle } from "./utils"

task(
  "relay-multisig-signer:check-hashes",
  "Checks transaction hashes from a transactions manifest file against a Gnosis Safe. They must match the transactions from the manifest."
)
  .addParam("transactions", "The path to the transactions manifest file")
  .addParam("relayMultisigSigner", "address of the relay multisig signer")
  .addParam("safeTransactionNonce", "nonce of the safe transaction")
  .setAction(
    async (
      {
        transactions: transactionsPath,
        relayMultisigSigner: relayMultisigSignerAddress,
        safeTransactionNonce,
      },
      hre
    ) => {
      const relayMultisigSigner = await hre.viem.getContractAt(
        "RelayMultisigSigner",
        relayMultisigSignerAddress
      )

      // TODO: should we handle this if the owner is _not_ a SAFE? (things will fail later).
      const safeMultisigAddress = await relayMultisigSigner.read.owner()

      const safe = await createSafeClientWithConfig(hre, safeMultisigAddress)

      const transactionBundle = await createTransactionBundle(
        transactionsPath,
        relayMultisigSigner as any
      )

      // Let's now load the transactions from the Safe
      const safeTransactionActions = await getPendingSafeTxActionsByNonce(
        safe.apiKit,
        safeMultisigAddress as `0x${string}`,
        safeTransactionNonce
      )

      if (safeTransactionActions.length !== transactionBundle.length) {
        throw new Error("❌ Action count mismatch...")
      }
      for (let i = 0; i < safeTransactionActions.length; i++) {
        const action = safeTransactionActions[i]
        if (
          checksumAddress(action.to as `0x${string}`) !==
          checksumAddress(relayMultisigSignerAddress)
        ) {
          throw new Error(
            `❌ Action ${i} is not addressed to the relay multisig signer`
          )
        }
        let matched = false
        for (let j = 0; j < transactionBundle.length; j++) {
          if (action.data === transactionBundle[j].data) {
            matched = true
          }
        }
        if (!matched) {
          throw new Error(
            `❌ Action ${i} data ${action.data} does not match any transaction!`
          )
        }
      }
      console.log(
        "✅ All actions match transactions generated from the manifest!"
      )
    }
  )
