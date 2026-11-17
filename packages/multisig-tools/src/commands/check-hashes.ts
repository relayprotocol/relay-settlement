import type { Command } from "commander"
import { checksumAddress } from "viem"
import {
  createSafeClientWithRpc,
  decodeSafeTransactionActions,
  getSafeTransactionByNonce,
} from "../helpers/safe"
import { createTransactionBundle } from "../builders/utils"
import { assertEnvOrSigner, resolveNetwork } from "../helpers/network"

export function registerCheckHashes(program: Command) {
  program
    .command("check-hashes")
    .description(
      "Verify the full pending or executed Safe transaction against the manifest."
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
      "Nonce of the Safe transaction"
    )
    .option(
      "--executed",
      "Check an executed Safe transaction without destination nonce checks or simulation (EVM and messages only)"
    )
    .option("-n, --network <slug>", "Network slug (from settlement-networks)")
    .option("--rpc-url <url>", "RPC URL override")
    .option(
      "--skip-simulation",
      "Skip EVM execution simulation when building approvals; execution still checks live state"
    )
    .option(
      "-e, --env <env>",
      "Deployment env for the --network contract lookup (prod | dev | stag | test | deployers); required unless --relay-multisig-signer is set"
    )
    .action(
      async ({
        transactions: transactionsPath,
        executed,
        relayMultisigSigner,
        safeTransactionNonce,
        network,
        rpcUrl,
        skipSimulation,
        env,
      }) => {
        if (
          !/^\d+$/.test(safeTransactionNonce) ||
          !Number.isSafeInteger(Number(safeTransactionNonce))
        ) {
          throw new Error(
            "Safe transaction nonce must be a non-negative safe integer"
          )
        }
        assertEnvOrSigner({ env, multisigSignerOverride: relayMultisigSigner })
        const resolved = resolveNetwork({
          env,
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
          multisigSignerAddress,
          { skipEvmStateChecks: executed, skipSimulation }
        )

        const safeTransaction = await getSafeTransactionByNonce(
          safe.apiKit,
          safeMultisigAddress,
          Number(safeTransactionNonce),
          { executed }
        )

        // Rebuild exactly as submit does. In particular, the SDK chooses the
        // canonical MultiSendCallOnly deployment for this chain/Safe version.
        // Never let service-decoded inner calls replace the outer transaction.
        const expectedTransaction = await safe.protocolKit.createTransaction({
          options: { nonce: Number(safeTransactionNonce) },
          transactions: transactionBundle,
        })
        for (const field of [
          "to",
          "value",
          "data",
          "operation",
          "nonce",
          "safeTxGas",
          "baseGas",
          "gasPrice",
          "gasToken",
          "refundReceiver",
        ] as const) {
          const actual = safeTransaction[field]
          const expected = expectedTransaction.data[field]
          if (
            actual === undefined ||
            actual === null ||
            String(actual).toLowerCase() !== String(expected).toLowerCase()
          ) {
            throw new Error(`❌ Safe transaction ${field} mismatch`)
          }
        }
        if (
          checksumAddress(safeTransaction.safe) !==
          checksumAddress(safeMultisigAddress)
        ) {
          throw new Error("❌ Safe transaction belongs to a different Safe")
        }
        const expectedHash =
          await safe.protocolKit.getTransactionHash(expectedTransaction)
        if (
          safeTransaction.safeTxHash?.toLowerCase() !==
          expectedHash.toLowerCase()
        ) {
          throw new Error("❌ Safe transaction hash mismatch")
        }

        const safeTransactionActions = decodeSafeTransactionActions(
          safeTransaction,
          { multiSend: transactionBundle.length > 1 }
        )

        if (safeTransactionActions.length !== transactionBundle.length) {
          throw new Error("❌ Action count mismatch...")
        }
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
          const expected = transactionBundle[i]
          if (
            action.data.toLowerCase() !== expected.data.toLowerCase() ||
            action.value !== expected.value ||
            action.operation !== 0
          ) {
            throw new Error(
              `❌ Action ${i} data, value or operation does not match the manifest`
            )
          }
        }
        console.log(
          `✅ Full Safe transaction matches the manifest! Safe transaction hash: ${expectedHash}`
        )
      }
    )
}
