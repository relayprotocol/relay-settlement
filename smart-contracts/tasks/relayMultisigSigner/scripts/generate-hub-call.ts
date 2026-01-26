// ABOUTME parse a manifest file for RelayHub operations to
// be submitted through RelayMultisgSigner
import { resolve } from "path"

import { writeFileSync, readdirSync } from "fs"
import { join } from "path"
import {
  relay as relayChain,
  aurora,
} from "@relay-protocol/settlement-networks"
import { createPublicClient, encodeFunctionData, http } from "viem"
import { RelayHub, ERC20View } from "@relay-protocol/settlement-abis"
import { deriveAllocatorSignerAddress } from "../../../lib/signer"

const HUB_ADDRESS = "0xDDD361727C22A01EB137880678A20b0BEaE69318"

/**
 * The calls could be any operation on Relay Hub :
 * - mint: [to, tokenId, amount]
 * - transfer: [from, to, tokenId, amount]
 * - burn: [from, tokenId, amount]
 * NB: You can find the tokenId from the Hub block explorer or relevant Erc20 view
 */
type HubCallArgs =
  | { method: "mint"; args: [string, string, string] }
  | { method: "transfer"; args: [string, string, string, string] }
  | { method: "burn"; args: [string, string, string] }

// Here we burn tokens that were minted to a deposit address after a
// after wrongfully parsing a duplicate ERC20 Transfer event emitted by ETH on ZKSync.
// deposit tx on zksync : https://explorer.zksync.io/tx/0x11b8dea036d0a470e5cecd5640ab3a9daf3f5b4cd9a20cbd461afbec26c6317a#eventlog
// MINT tx on hub : https://explorer.chain.relay.link/tx/0x34253f53eabece089301cea98b4f8fbfe54924172d012eb442b2434cd82105f4
const calls: HubCallArgs[] = [
  // params for burn (address, tokenId, amount).
  {
    args: [
      // token holder address on the hub
      "0x8559Fe293Cd68C2153bD1bf4ce620E891BA629A5",
      // hub token id for ETH on zksync
      "57184501712162055653871642087778677099634256213056275927084968567046829825789",
      // amount
      "5000000000000000",
    ],
    method: "burn",
  },
]

/**
 * Scans the given directory for transaction files (ignores files prefixed with "demo"),
 * parses the first three digits from each filename, and returns the biggest number found.
 * Returns undefined if no such file is found.
 */
function getLatestManifestIndex(transactionsDir: string): number | undefined {
  const dirPath = resolve(transactionsDir)
  const files = readdirSync(dirPath).filter(
    (fname) => !fname.startsWith("demo") && /^\d{3}/.test(fname) // must start with 3 digits
  )
  const numbers = files
    .map((fname) => parseInt(fname.substring(0, 3), 10))
    .filter((n) => !isNaN(n))
  return Math.max(...numbers)
}

const getOperationName = async ({ method, args }: HubCallArgs) => {
  // get nonce and estimate
  const relayChainClient = createPublicClient({
    transport: http(relayChain.rpc[0]),
  })

  const tokenId = method === "transfer" ? args[2] : args[1]
  const amount = method === "transfer" ? args[3] : args[2]

  const erc20View = await relayChainClient.readContract({
    abi: RelayHub,
    address: HUB_ADDRESS,
    args: [BigInt(tokenId)],
    functionName: "erc20Views",
  })

  const tokenName = await relayChainClient.readContract({
    abi: ERC20View,
    address: erc20View as `0x${string}`,
    functionName: "name",
  })

  return `${method}-${tokenName}-${amount}`
}
// network params
const hubAddress = HUB_ADDRESS

// TODO: update gas param once fee returned by the relay chain is accurate
const maxFeePerGas = 7n
const maxPriorityFeePerGas = 0n

function stringifyJsonWithBigInt(obj: any) {
  return JSON.stringify(
    obj,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  )
}

const main = async () => {
  const multisigSigner = aurora.contracts?.prod?.multisigSigner
  if (!multisigSigner) throw new Error("MultisigSigner not found")

  const auroraClient = createPublicClient({
    transport: http(aurora.rpc[0]),
  })

  const signerAddress = await deriveAllocatorSignerAddress(
    auroraClient,
    multisigSigner,
    "ethereum-vm"
  )
  if (!signerAddress) throw new Error("Failed to derive signer")
  console.log(`Using signer from MPC : ${signerAddress}`)

  const operationNames = (
    await Promise.all(calls.map((call) => getOperationName(call)))
  )
    .join("_")
    .replace(/ /g, "-")
  console.log(`Operation names: ${operationNames}`)

  const txs = await Promise.all(
    calls.map(async ({ method, args }) => {
      const calldata = encodeFunctionData({
        abi: RelayHub,
        args: args,
        functionName: method,
      })

      // get nonce and estimate
      const relayChainClient = createPublicClient({
        transport: http(relayChain.rpc[0]),
      })

      const [nonce, gas] = await Promise.all([
        relayChainClient.getTransactionCount({
          address: signerAddress as `0x${string}`,
        }),
        relayChainClient.estimateGas({
          account: signerAddress as `0x${string}`,
          data: calldata,
          to: hubAddress,
        }),
      ])

      const tx = {
        amount: "0",
        calldata,
        family: "ethereum-vm",
        from: signerAddress,
        gas: ((gas * 110n) / 100n).toString(), // bump estimtea
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
        rpc: relayChain.rpc[0],
        to: hubAddress,
      }
      return tx
    })
  )

  const txManifestsDir = join(__dirname, "../transactions")
  const numberPrefix = getLatestManifestIndex(txManifestsDir) || 0
  const path = join(
    txManifestsDir,
    `${(numberPrefix + 1).toString().padStart(3, "0")}-hub-calls-${operationNames.slice(0, 50)}.json`
  )
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`✅ Generated: ${path}`)
  console.log(`\n📝 Generated ${txs.length} transaction(s)`)
}

main().catch(console.error)
