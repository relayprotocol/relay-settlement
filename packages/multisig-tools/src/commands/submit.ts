import type { Command } from "commander"
import { checksumAddress } from "viem"
import { createSafeClient } from "@safe-global/sdk-starter-kit"
import { createTransactionBundle } from "../builders/utils"
import { resolveNetwork } from "../helpers/network"

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
    .action(
      async ({
        transactions: transactionsPath,
        relayMultisigSigner,
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

        const nonce = await safe.getNonce()
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
