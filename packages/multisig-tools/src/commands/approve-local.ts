// ABOUTME Approve a manifest's signature hashes on the RelayMultisigSigner by
// executing the Safe transaction directly on-chain, bypassing the Safe
// transaction service and web UI. Useful when the Safe UI is unavailable.
//
// Requires enough Safe owner keys to meet the threshold, provided via
// SAFE_OWNER_KEYS (comma-separated) or DEPLOYER_PRIVATE_KEY / PRIVATE_KEY.
import type { Command } from "commander"
import Safe from "@safe-global/protocol-kit"
import { checksumAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { createTransactionBundle } from "../builders/utils"
import { resolveNetwork } from "../helpers/network"

const loadOwnerKeys = (): `0x${string}`[] => {
  const raw =
    process.env.SAFE_OWNER_KEYS ??
    process.env.DEPLOYER_PRIVATE_KEY ??
    process.env.PRIVATE_KEY
  if (!raw) {
    throw new Error(
      "Set SAFE_OWNER_KEYS (comma-separated) or DEPLOYER_PRIVATE_KEY in the environment."
    )
  }
  return raw
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`)
}

export function registerApproveLocal(program: Command) {
  program
    .command("approve-local")
    .description(
      "Approve a manifest's hashes on the relay multisig signer by executing the Safe " +
        "transaction directly on-chain (no Safe UI / transaction service). Requires enough " +
        "owner keys to meet the Safe threshold."
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

        // The Safe is the owner of the relay multisig signer.
        const safeAddress = (await resolved.publicClient.readContract({
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
        console.log(`🔐 Safe (owner of multisig signer): ${safeAddress}`)

        const ownerKeys = loadOwnerKeys()

        let safe = await Safe.init({
          provider: resolved.rpc,
          safeAddress: checksumAddress(safeAddress),
          signer: ownerKeys[0],
        })

        const threshold = await safe.getThreshold()
        console.log(
          `🔎 Safe threshold: ${threshold}, keys provided: ${ownerKeys.length}`
        )
        if (ownerKeys.length < threshold) {
          throw new Error(
            `Safe threshold is ${threshold} but only ${ownerKeys.length} owner key(s) ` +
              "were provided. Pass more keys via SAFE_OWNER_KEYS (comma-separated)."
          )
        }

        for (const key of ownerKeys) {
          const address = privateKeyToAccount(key).address
          if (!(await safe.isOwner(address))) {
            throw new Error(`${address} is not an owner of Safe ${safeAddress}`)
          }
          console.log(`✅ ${address} is a Safe owner`)
        }

        const transactionBundle = await createTransactionBundle(
          transactionsPath,
          resolved.multisigSignerAddress
        )

        // Sanity check: simulate the bundle from the Safe before signing.
        for (const action of transactionBundle) {
          await resolved.publicClient.estimateGas({
            account: safeAddress,
            data: action.data,
            to: action.to,
            value: BigInt(action.value),
          })
        }

        let safeTransaction = await safe.createTransaction({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transactions: transactionBundle as any,
        })

        // Collect owner signatures locally until the threshold is met.
        for (const key of ownerKeys.slice(0, threshold)) {
          safe = await safe.connect({ signer: key })
          safeTransaction = await safe.signTransaction(safeTransaction)
        }

        console.log("🚀 Executing Safe transaction on-chain...")
        const result = await safe.executeTransaction(safeTransaction)
        console.log(`   Execution tx: ${result.hash}`)

        const receipt = await resolved.publicClient.waitForTransactionReceipt({
          hash: result.hash as `0x${string}`,
        })
        if (receipt.status !== "success") {
          throw new Error(`❌ Safe execution reverted: ${result.hash}`)
        }
        console.log(`✅ Hashes approved on-chain: ${result.hash}`)
        console.log(
          "   Next: run `execute-transactions` with the same manifest to sign via MPC and broadcast."
        )
      }
    )
}
