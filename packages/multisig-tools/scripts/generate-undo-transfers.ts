// ABOUTME generate a manifest that reverses every Hub transfer emitted by a
// given RelayHub transaction, to be submitted through RelayMultisigSigner.
import { writeFileSync } from "fs"
import { decodeEventLog, encodeFunctionData } from "viem"
import { RelayHub } from "@relay-protocol/settlement-abis"
import {
  getSignerAddress,
  createRelayChainClient,
  RELAY_CHAIN_HUB_ADDRESS,
  RELAY_CHAIN_GAS_CONFIG,
} from "./helpers/chains"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

// Transaction whose Hub transfers we want to undo.
const TX_HASH =
  "0xad7820b775c049013c8b0fd2c77e5b9da86041b22762eb6e5bf553954ff0fbd3"

type HubTransfer = {
  from: `0x${string}`
  to: `0x${string}`
  id: bigint
  amount: bigint
}

const main = async () => {
  const signerAddress = (await getSignerAddress()) as `0x${string}`
  console.log(`Using signer from MPC : ${signerAddress}`)

  const { client: relayChainClient, rpcUrl } = createRelayChainClient()

  const receipt = await relayChainClient.getTransactionReceipt({
    hash: TX_HASH as `0x${string}`,
  })

  // Collect every RelayHub `Transfer` event emitted by the Hub contract.
  const transfers: HubTransfer[] = []
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== RELAY_CHAIN_HUB_ADDRESS.toLowerCase()) {
      continue
    }
    try {
      const decoded = decodeEventLog({
        abi: RelayHub,
        data: log.data,
        topics: log.topics,
      })
      if (decoded.eventName !== "Transfer") continue
      const args = decoded.args as unknown as {
        from: `0x${string}`
        to: `0x${string}`
        id: bigint
        amount: bigint
      }
      transfers.push({
        amount: args.amount,
        from: args.from,
        id: args.id,
        to: args.to,
      })
    } catch {
      // Not a Transfer event we care about.
    }
  }

  console.log(`Found ${transfers.length} Hub transfer(s) to undo`)
  transfers.forEach((t, i) => {
    console.log(
      `  ${i + 1}: ${t.from} -> ${t.to} | id ${t.id} | amount ${t.amount}`
    )
  })

  // Nonce increments across the batch since all txs share the same signer.
  const startNonce = await relayChainClient.getTransactionCount({
    address: signerAddress,
  })

  const txs = await Promise.all(
    transfers.map(async (transfer, index) => {
      // Reverse the transfer: sender and receiver are swapped.
      const calldata = encodeFunctionData({
        abi: RelayHub,
        args: [transfer.to, transfer.from, transfer.id, transfer.amount],
        functionName: "transferFrom",
      })

      const gas = await relayChainClient.estimateGas({
        account: signerAddress,
        data: calldata,
        to: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
      })

      return {
        amount: "0",
        calldata,
        family: "ethereum-vm",
        from: signerAddress,
        gas: ((gas * 110n) / 100n).toString(),
        maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas.toString(),
        maxPriorityFeePerGas:
          RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas.toString(),
        nonce: startNonce + index,
        rpc: rpcUrl,
        to: RELAY_CHAIN_HUB_ADDRESS,
      }
    })
  )

  const path = getManifestPath("undo-transfers", TX_HASH.slice(0, 10))
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch(console.error)
