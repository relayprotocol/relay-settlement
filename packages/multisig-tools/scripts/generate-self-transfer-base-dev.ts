// ABOUTME generate a manifest with a single 0-value self-transfer on Base from
// the DEV RelayMultisigSigner's derived EVM wallet — a smoke test for the
// submit → sign → execute (Safe approval + NEAR MPC signing + broadcast) flow.
import { writeFileSync } from "fs"
import { createPublicClient, http } from "viem"
import networks from "@relay-protocol/settlement-networks"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

// Derived EVM wallet controlled by the dev RelayMultisigSigner
// (`derive-signer-address.ts --family ethereum-vm --env dev`).
const DEV_SIGNER_WALLET = "0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"

async function main() {
  const base = networks["base"]
  if (!base) {
    throw new Error("base network config not found")
  }
  const rpcUrl = base.rpc[0]
  const client = createPublicClient({ transport: http(rpcUrl) })

  const [nonce, gasPrice] = await Promise.all([
    client.getTransactionCount({ address: DEV_SIGNER_WALLET }),
    client.getGasPrice(),
  ])

  const tx = {
    amount: "0",
    calldata: "0x",
    family: "ethereum-vm",
    from: DEV_SIGNER_WALLET,
    // Plain value transfer to self: fixed 21k gas.
    gas: "21000",
    maxFeePerGas: (gasPrice * 2n).toString(),
    maxPriorityFeePerGas: gasPrice.toString(),
    nonce,
    rpc: rpcUrl,
    to: DEV_SIGNER_WALLET,
  }

  const path = getManifestPath("self-transfer-base-dev", "smoke-test", "dev")
  writeFileSync(path, `${stringifyJsonWithBigInt([tx])}\n`)

  console.log(`✅ Generated: ${path}`)
  console.log(
    `   self-transfer 0 ETH on base: ${DEV_SIGNER_WALLET} -> itself (nonce ${nonce})`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
