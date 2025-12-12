import { task } from "hardhat/config"
import * as tronweb from "tronweb"

task(
  "relay-multisig-signer:generate-tron-headers",
  "Generate Tron transaction headers (refBlockBytes, refBlockHash, timestamp, expiration)"
)
  .addParam("rpc", "Tron RPC endpoint URL")
  .setAction(async ({ rpc }) => {
    const tronWeb = new tronweb.TronWeb({
      fullHost: rpc,
      fullNode: new tronweb.providers.HttpProvider(rpc),
    })

    const block = await tronWeb.trx.getCurrentBlock()
    const blockNum = block.block_header.raw_data.number
    const blockTimestamp = block.block_header.raw_data.timestamp

    const headers = {
      expiration: blockTimestamp + 60 * 60 * 16 * 1000,
      refBlockBytes: blockNum.toString(16).slice(-4).padStart(4, "0"),
      refBlockHash: block.blockID.slice(16, 32),
      timestamp: blockTimestamp, // 16 hours
    }

    console.log("\n📋 Generated Tron transaction headers:\n")
    console.log(JSON.stringify(headers, null, 2))
    console.log("\n📝 Add these fields to your transaction JSON:\n")
    console.log(`  "refBlockBytes": "${headers.refBlockBytes}",`)
    console.log(`  "refBlockHash": "${headers.refBlockHash}",`)
    console.log(`  "timestamp": ${headers.timestamp},`)
    console.log(`  "expiration": ${headers.expiration}`)
    console.log(
      `\n⏰ Transaction will expire at: ${new Date(headers.expiration).toISOString()}\n`
    )

    return headers
  })
