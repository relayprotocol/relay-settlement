import type { Command } from "commander"
import { checksumAddress } from "viem"
import { createSafeClient } from "@safe-global/sdk-starter-kit"
import { createTransactionBundle } from "../builders/utils"
import { assertEnvOrSigner, resolveNetwork } from "../helpers/network"
import {
  describeNonceConflicts,
  findNonceConflicts,
} from "../helpers/nonceConflicts"

export function registerSubmit(program: Command) {
  program
    .command("submit")
    .description(
      "Submit a transactions manifest to the Gnosis Safe transaction service for signing."
    )
    .requiredOption(
      "-t, --transactions <path>",
      "Path to the transactions manifest JSON file"
    )
    .option(
      "--relay-multisig-signer <address>",
      "Address of the relay multisig signer (overrides --network lookup)"
    )
    .option("-n, --network <slug>", "Network slug (from settlement-networks)")
    .option("--rpc-url <url>", "RPC URL override")
    .option(
      "-e, --env <env>",
      "Deployment env for the --network contract lookup (prod | dev | stag); required unless --relay-multisig-signer is set"
    )
    .option(
      "--allow-nonce-conflict",
      "Submit even if another manifest claims the same nonce slot"
    )
    .action(
      async ({
        transactions: transactionsPath,
        relayMultisigSigner,
        network,
        rpcUrl,
        env,
        allowNonceConflict,
      }) => {
        assertEnvOrSigner({ env, multisigSignerOverride: relayMultisigSigner })

        // Two manifests written against the same starting nonce both pass the
        // on-chain nonce check while both are pending; the one that executes
        // second is left unexecutable. Catch that before owners spend a signing
        // round on it.
        const conflicts = await findNonceConflicts(transactionsPath)
        if (conflicts.length > 0) {
          const details = describeNonceConflicts(conflicts)
          if (!allowNonceConflict) {
            throw new Error(
              `❌ Nonce conflict: another manifest claims the same unexecuted nonce slot(s):\n${details}\n   Whichever executes first burns the nonce and leaves the other dead. Regenerate this manifest against the current nonce, or pass --allow-nonce-conflict if the other manifest is being abandoned.`
            )
          }
          console.warn(`⚠️  Submitting despite nonce conflict(s):\n${details}`)
        }

        const resolved = resolveNetwork({
          env,
          multisigSignerOverride: relayMultisigSigner as
            | `0x${string}`
            | undefined,
          network,
          rpcOverride: rpcUrl,
        })

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
          address: resolved.multisigSignerAddress,
          functionName: "owner",
        })) as `0x${string}`

        const safe = await createSafeClient({
          apiKey: process.env.SAFE_API_KEY!,
          provider: resolved.rpc,
          safeAddress: safeMultisigAddress,
          signer: (process.env.DEPLOYER_PRIVATE_KEY ??
            process.env.PRIVATE_KEY)!,
        })

        const transactionBundle = await createTransactionBundle(
          transactionsPath,
          resolved.multisigSignerAddress
        )

        for (let i = 0; i < transactionBundle.length; i++) {
          const action = transactionBundle[i]
          await resolved.publicClient.estimateGas({
            account: safeMultisigAddress,
            data: action.data,
            to: action.to,
            value: BigInt(action.value),
          })
        }

        // Use the next nonce after the last *pending* Safe transaction so we
        // don't collide with transactions that are already proposed but not yet
        // executed (e.g. a queued tx with nonce 10 means we must use 11). Falls
        // back to the on-chain nonce if the transaction service is unavailable.
        let nonce: number
        try {
          nonce = Number(
            await safe.apiKit.getNextNonce(checksumAddress(safeMultisigAddress))
          )
        } catch (error) {
          console.warn(
            `⚠️  Could not fetch next nonce from the Safe transaction service, falling back to on-chain nonce: ${
              (error as Error).message
            }`
          )
          nonce = await safe.getNonce()
        }
        console.log("📦 Submitting hashes to be signed")

        const safeTransaction = await safe.protocolKit.createTransaction({
          options: { nonce },
          transactions: transactionBundle as any,
        })

        const safeTxHash =
          await safe.protocolKit.getTransactionHash(safeTransaction)
        const signature = await safe.protocolKit.signHash(safeTxHash)
        console.log(`🗳️  Proposing transaction ${nonce} to multisig`)

        await safe.apiKit.proposeTransaction({
          safeAddress: checksumAddress(safeMultisigAddress),
          safeTransactionData: safeTransaction.data,
          safeTxHash: safeTxHash,
          senderAddress: checksumAddress(resolved.walletClient.account.address),
          senderSignature: signature.data,
        })
      }
    )
}
