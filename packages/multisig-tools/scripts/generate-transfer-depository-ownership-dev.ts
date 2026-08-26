// ABOUTME generate a manifest that transfers ownership of the DEV RelayDepository
// on each supported ethereum-vm chain from the current owner to the dev security
// council, signed by the current owner via its RelayMultisigSigner.
import { writeFileSync } from "fs"
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem"
import networks from "@relay-protocol/settlement-networks"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

// Current depository owner (the wallet derived from the RelayMultisigSigner
// 0x66667945C34b399993cA834587886b8508dB39B1). It signs every transfer.
const CURRENT_OWNER = "0x16c4dEEB433bde1804d8f17cd1Ba3D29a30f9671"

// New owner: the dev security council (dev RelayMultisigSigner's derived wallet).
const NEW_OWNER = "0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"

const CHAINS = [
  "ethereum",
  "optimism",
  "polygon",
  "abstract",
  "base",
  "arbitrum",
]

// RelayDepository is Solady `Ownable`; `transferOwnership` is a direct,
// single-step transfer callable by the current owner.
const ownableAbi = parseAbi(["function transferOwnership(address newOwner)"])

async function main() {
  const calldata = encodeFunctionData({
    abi: ownableAbi,
    args: [NEW_OWNER],
    functionName: "transferOwnership",
  })

  const txs = await Promise.all(
    CHAINS.map(async (chainId) => {
      const net = networks[chainId]
      if (!net) {
        throw new Error(`no network config for "${chainId}"`)
      }
      const depository = net.contracts?.dev?.depository
      if (!depository) {
        throw new Error(`no dev depository configured for "${chainId}"`)
      }
      const rpcUrl = net.rpc[0]
      const client = createPublicClient({ transport: http(rpcUrl) })

      const [nonce, gasPrice, gas] = await Promise.all([
        client.getTransactionCount({ address: CURRENT_OWNER }),
        client.getGasPrice(),
        // Reverts unless CURRENT_OWNER is the depository's owner — a built-in
        // guard that the manifest targets the right owner/chain.
        client.estimateGas({
          account: CURRENT_OWNER,
          data: calldata,
          to: depository,
        }),
      ])

      return {
        amount: "0",
        calldata,
        family: "ethereum-vm",
        from: CURRENT_OWNER,
        gas: ((gas * 12n) / 10n).toString(),
        maxFeePerGas: (gasPrice * 2n).toString(),
        maxPriorityFeePerGas: gasPrice.toString(),
        nonce,
        rpc: rpcUrl,
        to: depository,
      }
    })
  )

  const path = getManifestPath(
    "transfer-dev-depository-ownership",
    CHAINS.join("-"),
    "dev"
  )
  writeFileSync(path, `${stringifyJsonWithBigInt(txs)}\n`)

  console.log(`✅ Generated: ${path}`)
  console.log(
    `   transferOwnership -> ${NEW_OWNER} on ${txs.length} chain(s), signed by ${CURRENT_OWNER}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
