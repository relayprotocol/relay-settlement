import type { Command } from "commander"
import { checksumAddress } from "viem"
import {
  createSafeClientWithRpc,
  getPendingSafeTxActionsByNonce,
} from "../helpers/safe"
import { createTransactionBundle } from "../builders/utils"
import { resolveNetwork } from "../helpers/network"

export function registerCheckHashes(program: Command) {
  program
    .command("check-hashes")
    .description(
      "Verify that the action hashes inside a pending Safe transaction match what the manifest produces."
    )
    .requiredOption(
      "-t, --transactions <path>",
      "Path to the transactions manifest JSON file"
    )
    .option(
      "--relay-multisig-signer <address>",
      "Address of the relay multisig signer (overrides --network lookup)"
    )
    .requiredOption(
      "--safe-transaction-nonce <number>",
      "Nonce of the pending Safe transaction"
    )
    .option("-n, --network <slug>", "Network slug (from settlement-networks)")
    .option("--rpc-url <url>", "RPC URL override")
    .action(
      async ({
        transactions: transactionsPath,
        relayMultisigSigner,
        safeTransactionNonce,
        network,
        rpcUrl,
      }) => {
        const resolved = resolveNetwork({
          multisigSignerOverride: relayMultisigSigner as
            | `0x${string}`
            | undefined,
          network,
          rpcOverride: rpcUrl,
        })

        const multisigSignerAddress = resolved.multisigSignerAddress

        const safeMultisigAddress = (await resolved.publicClient.readContract({
          abi: [
            {
              inputs: [],
              name: "owner",
              outputs: [{ name: "", type: "address" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          address: multisigSignerAddress,
          functionName: "owner",
        })) as `0x${string}`

        const safe = await createSafeClientWithRpc(
          resolved.rpc,
          safeMultisigAddress
        )

        const transactionBundle = await createTransactionBundle(
          transactionsPath,
          multisigSignerAddress
        )

        const safeTransactionActions = await getPendingSafeTxActionsByNonce(
          safe.apiKit,
          safeMultisigAddress,
          Number(safeTransactionNonce)
        )

        if (safeTransactionActions.length !== transactionBundle.length) {
          throw new Error("❌ Action count mismatch...")
        }
        // Track which bundle entries have been matched so a duplicate Safe
        // action can't satisfy two manifest entries (e.g. Safe payload [A, A]
        // would otherwise pass against manifest bundle [A, B]).
        const usedBundleIndices = new Set<number>()
        for (let i = 0; i < safeTransactionActions.length; i++) {
          const action = safeTransactionActions[i]
          if (
            checksumAddress(action.to as `0x${string}`) !==
            checksumAddress(multisigSignerAddress)
          ) {
            throw new Error(
              `❌ Action ${i} is not addressed to the relay multisig signer`
            )
          }
          let matchedIndex = -1
          for (let j = 0; j < transactionBundle.length; j++) {
            if (
              !usedBundleIndices.has(j) &&
              action.data === transactionBundle[j].data
            ) {
              matchedIndex = j
              break
            }
          }
          if (matchedIndex === -1) {
            throw new Error(
              `❌ Action ${i} data ${action.data} does not match any unmatched transaction!`
            )
          }
          usedBundleIndices.add(matchedIndex)
        }
        console.log(
          "✅ All actions match transactions generated from the manifest!"
        )
      }
    )
}
