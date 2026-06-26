import type { Command } from "commander"
import {
  createSafeClientWithRpc,
  getPendingSafeTxActionsByNonce,
} from "../helpers/safe"
import { resolveNetwork } from "../helpers/network"

const formatDecoded = (decoded: any) => {
  if (!decoded) return "(no decoded data)"
  const method = decoded.method ?? "(unknown method)"
  const params = Array.isArray(decoded.parameters)
    ? decoded.parameters
        .map((p: any) => `  - ${p.name ?? "?"} (${p.type ?? "?"}): ${p.value}`)
        .join("\n")
    : ""
  return `${method}\n${params}`
}

export function registerDecodeMulticall(program: Command) {
  program
    .command("decode-multicall")
    .description(
      "Decode every inner action of a pending Safe (multiSend) transaction."
    )
    .option("--safe-address <address>", "Address of the Safe")
    .option("--nonce <number>", "Nonce of the safe transaction to decode")
    .option("-n, --network <slug>", "Network slug (from settlement-networks)")
    .option("--rpc-url <url>", "RPC URL override")
    .action(async ({ safeAddress, nonce, network, rpcUrl }) => {
      if (!safeAddress || nonce === undefined) {
        throw new Error("Need to provide both --safe-address and --nonce")
      }

      const { rpc } = resolveNetwork({
        network,
        rpcOverride: rpcUrl,
      })

      const safe = await createSafeClientWithRpc(
        rpc,
        safeAddress as `0x${string}`
      )

      const safeTransactionActions = await getPendingSafeTxActionsByNonce(
        safe.apiKit,
        safeAddress as `0x${string}`,
        Number(nonce)
      )

      console.log(
        `Found ${safeTransactionActions.length} actions in Safe transaction\n`
      )

      for (let i = 0; i < safeTransactionActions.length; i++) {
        const action = safeTransactionActions[i]
        console.log(`Action ${i}: to ${action.to}, value ${action.value}`)
        if (!action.data || action.data === "0x") {
          console.log("  (no calldata)")
          continue
        }
        // dataDecoded is populated by getPendingSafeTxActionsByNonce when the
        // Safe transaction service recognises the ABI.
        if (action.dataDecoded) {
          console.log(`  ${formatDecoded(action.dataDecoded)}`)
          continue
        }
        try {
          const decoded = await safe.apiKit.decodeData(action.data, action.to)
          console.log(`  ${formatDecoded(decoded)}`)
        } catch (err) {
          console.log(`  Calldata: ${action.data}`)
          console.log(
            `  (Safe transaction service could not decode: ${err instanceof Error ? err.message : String(err)})`
          )
        }
      }
      console.log(
        "\nReference addresses: https://docs.relay.link/references/protocol/depository/addresses"
      )
    })
}
