/**
 * Regenerates the Tron `setAllocator` transaction for the prod Tron depository
 * with all TAPOS reference fields populated and the maximum usable expiration.
 *
 * The previous manifest entry failed to broadcast because it was missing the
 * `refBlockBytes` / `refBlockHash` / `timestamp` / `expiration` fields and had
 * already expired. This script fetches fresh reference-block data from the Tron
 * node and writes a fully-specified transaction.
 *
 * NOTE on Tron expiration: two limits apply.
 *   1. TAPOS: the transaction is only valid while the referenced block stays
 *      within the node's recent-block window (~65,535 blocks, ~54h at 3s/block).
 *   2. Node cap: java-tron rejects any transaction whose expiration is more
 *      than MAXIMUM_TIME_UNTIL_EXPIRATION (24h) past the head block time, with
 *      "Transaction expiration time is too long".
 * The 24h node cap is the binding constraint and sits well inside the TAPOS
 * window, so we set the expiration to exactly 24h from the referenced block.
 * Re-run this script close to broadcast time so the full 24h window is fresh.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools \
 *     tsx scripts/generate-tron-set-allocator.ts \
 *     > transactions/053-tron-set-allocator.json
 */
import * as tronweb from "tronweb"

// --- Transaction parameters (preserved from the original 050 entry) ---------

const RPC = "https://api.trongrid.io"
// Multisig signer on Tron.
const FROM = "TYQUbsiQjJoDCyP2Au22kHCGb6AbEJAbJp"
// Prod Tron depository contract.
const CONTRACT_ADDRESS = "TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN"
// setAllocator(0x5d7a4a396fb6c1170432ca22c8ac3377e99c28c5)
const DATA =
  "bf83f2a20000000000000000000000005d7a4a396fb6c1170432ca22c8ac3377e99c28c5"
const FEE_LIMIT = "100000000"

// Maximum expiration accepted by Tron nodes (MAXIMUM_TIME_UNTIL_EXPIRATION),
// which also fits comfortably within the ~54h TAPOS reference-block window.
const EXPIRATION_MS = 24 * 60 * 60 * 1000 // 24 hours

const main = async () => {
  const tronWeb = new tronweb.TronWeb({
    fullHost: RPC,
    fullNode: new tronweb.providers.HttpProvider(RPC),
  })

  const block = await tronWeb.trx.getCurrentBlock()
  const blockNum = block.block_header.raw_data.number
  const blockTimestamp = block.block_header.raw_data.timestamp

  const refBlockBytes = blockNum.toString(16).slice(-4).padStart(4, "0")
  const refBlockHash = block.blockID.slice(16, 32)
  const timestamp = blockTimestamp
  const expiration = blockTimestamp + EXPIRATION_MS

  const tx = {
    contractType: "TriggerSmartContract",
    expiration,
    family: "tron-vm",
    feeLimit: FEE_LIMIT,
    from: FROM,
    parameter: {
      contract_address: CONTRACT_ADDRESS,
      data: DATA,
      owner_address: FROM,
    },
    refBlockBytes,
    refBlockHash,
    rpc: RPC,
    timestamp,
  }

  console.error(`✓ refBlock #${blockNum} (${refBlockBytes} / ${refBlockHash})`)
  console.error(`✓ timestamp:  ${new Date(timestamp).toISOString()}`)
  console.error(`✓ expiration: ${new Date(expiration).toISOString()}`)

  console.log(JSON.stringify([tx], null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
