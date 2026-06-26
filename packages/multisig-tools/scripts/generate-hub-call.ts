// ABOUTME parse a manifest file for RelayHub operations to
// be submitted through RelayMultisgSigner
import { writeFileSync } from "fs"
import { createPublicClient, encodeFunctionData, http } from "viem"
import { relay as relayChain } from "@relay-protocol/settlement-networks"
import { RelayHub, ERC20View } from "@relay-protocol/settlement-abis"
import {
  getSignerAddress,
  createRelayChainClient,
  RELAY_CHAIN_HUB_ADDRESS,
  RELAY_CHAIN_GAS_CONFIG,
} from "./helpers/chains"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

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

const getOperationName = async ({ method, args }: HubCallArgs) => {
  const relayChainClient = createPublicClient({
    transport: http(relayChain.rpc[0]),
  })

  const tokenId = method === "transfer" ? args[2] : args[1]
  const amount = method === "transfer" ? args[3] : args[2]

  const erc20View = await relayChainClient.readContract({
    abi: RelayHub,
    address: RELAY_CHAIN_HUB_ADDRESS,
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

const main = async () => {
  const signerAddress = await getSignerAddress()
  console.log(`Using signer from MPC : ${signerAddress}`)

  const operationNames = (await Promise.all(calls.map(getOperationName)))
    .join("_")
    .replace(/ /g, "-")
  console.log(`Operation names: ${operationNames}`)

  const { client: relayChainClient, rpcUrl } = createRelayChainClient()
  const txs = await Promise.all(
    calls.map(async ({ method, args }) => {
      const calldata = encodeFunctionData({
        abi: RelayHub,
        args: args,
        functionName: method,
      })

      const [nonce, gas] = await Promise.all([
        relayChainClient.getTransactionCount({
          address: signerAddress as `0x${string}`,
        }),
        relayChainClient.estimateGas({
          account: signerAddress as `0x${string}`,
          data: calldata,
          to: HUB_ADDRESS,
        }),
      ])

      return {
        amount: "0",
        calldata,
        family: "ethereum-vm",
        from: signerAddress,
        gas: ((gas * 110n) / 100n).toString(),
        maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
        maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
        nonce,
        rpc: rpcUrl,
        to: RELAY_CHAIN_HUB_ADDRESS,
      }
    })
  )

  const path = getManifestPath("hub-calls", operationNames)
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`✅ Generated: ${path}`)
  console.log(`\n📝 Generated ${txs.length} transaction(s)`)
}

main().catch(console.error)
