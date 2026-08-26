// ABOUTME generate a manifest that suspends spender aliases on the
// RelayAllocator (relay chain), to be submitted through RelayMultisigSigner.
//
// Each flagged spender is aliased with Utils.generateAddress(spenderChainId,
// spender) — the same derivation RelayAllocator applies to withdraw requests —
// so suspending the alias blocks every withdrawal path for that spender.
//
// NOTE: suspend() is onlyOwner and the owner is the multisig signer EOA, so
// the calls cannot be batched through Multicall3 (msg.sender would become the
// Multicall3 contract). We emit one transaction per alias instead, sharing the
// signer nonce sequence like the other relay-chain manifests.
import { writeFileSync } from "fs"
import { encodeFunctionData, getAddress } from "viem"
import { RelayAllocator, RelayHub } from "@relay-protocol/settlement-abis"
import {
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk"
import {
  getSignerAddress,
  createRelayChainClient,
  RELAY_CHAIN_HUB_ADDRESS,
  RELAY_CHAIN_GAS_CONFIG,
} from "./helpers/chains"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

// RelayAllocator on the relay chain (owner == multisig signer).
const ALLOCATOR = getAddress("0x613D3c588F6B8f89302b463F8F19f7241B2857E2")

// Chain the flagged spenders operate from (Arbitrum One).
const SPENDER_CHAIN_ID = "42161"

// Wallets flagged in INC-13 (Ostium-linked, blocked by screening). Duplicates
// are removed below before building transactions.
const FLAGGED_SPENDERS = [
  "0x08389D9e9DB34E8473435cd3D261111394c0C2Bd",
  "0x0Ef226a7FDbc35b139867d6d2e032e420A12AC0a",
  "0x2F5f487596456a7924Ad7d41a10Fc1A7f49aA64B",
  "0x5FEA0222695C2b4aBc4Ec15A9dE55Ff29594a457",
  "0x6d15fc3576e5a55F4D9e516DDa888C568b67a45c",
  "0x0Ef226a7FDbc35b139867d6d2e032e420A12AC0a",
  "0xc0670dDF78c19cbDb81dD662Ae223F6a5C6379C3",
]

// Relay request ids of the stuck deposits (INC-13), reported alongside the
// spender aliases so reviewers can see where the hub balances actually sit.
const REQUEST_IDS = [
  "0x5b661b1fdf006e2cff0cea588c5e68bc55d500daeb2b7f69ffe8128288e136cc",
  "0x43abb06de5b4a25a2363dbb2fd36cc03b0d9d27e3da49b1aa90e19bfdac3bf6f",
  "0x08e0a2574158b9681c50d19439281f0b1173600a265ac70f94b0634e630a98b2",
  "0xc8645d613395775263ecff798fd20453662d3705c9c1adc9bb866c10e07ab8fe",
  "0xffb855bcc866a5abb048e28301cdd63e4b7ab6efedbfe2e81e0921cbb6ceb97e",
  "0xf1e3a1ac4346bde924128a7b26d81e7d2b58be69a30b413966ba7f369aa6e465",
]

// Native ETH on the spender chain, used to report hub balances for review.
const ETH_TOKEN_ID = generateTokenId({
  address: "0x0000000000000000000000000000000000000000",
  chainId: SPENDER_CHAIN_ID,
  family: "ethereum-vm",
})

const main = async () => {
  const signerAddress = (await getSignerAddress()) as `0x${string}`
  console.log(`Using signer from MPC : ${signerAddress}`)

  const { client: relayChainClient, rpcUrl } = createRelayChainClient()

  const owner = await relayChainClient.readContract({
    abi: RelayAllocator,
    address: ALLOCATOR,
    functionName: "owner",
  })
  if (getAddress(owner as string) !== getAddress(signerAddress)) {
    throw new Error(
      `Signer ${signerAddress} is not the RelayAllocator owner (${owner})`
    )
  }

  const spenders = [...new Set(FLAGGED_SPENDERS.map((s) => getAddress(s)))]

  // Report each alias' current state so reviewers can sanity-check the batch.
  const aliases: `0x${string}`[] = []
  for (const spender of spenders) {
    const spenderAlias = generateAddress({
      address: spender,
      chainId: SPENDER_CHAIN_ID,
      family: "ethereum-vm",
    })

    const [alreadySuspended, hubEthBalance] = await Promise.all([
      relayChainClient.readContract({
        abi: RelayAllocator,
        address: ALLOCATOR,
        args: [spenderAlias],
        functionName: "suspended",
      }),
      relayChainClient.readContract({
        abi: RelayHub,
        address: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
        args: [spenderAlias, ETH_TOKEN_ID],
        functionName: "balanceOf",
      }),
    ])

    console.log(
      `${spender} -> alias ${spenderAlias} | suspended: ${alreadySuspended} | hub ETH(${SPENDER_CHAIN_ID}) balance: ${hubEthBalance}`
    )

    if (alreadySuspended) {
      console.log("  already suspended, skipping")
      continue
    }
    aliases.push(spenderAlias)
  }

  // Report-only: hub ETH balances for the aliases derived from the request
  // (order) ids, in case deposits were credited per order instead of per
  // spender. These are not added to the suspend batch automatically.
  for (const requestId of REQUEST_IDS) {
    const orderAlias = generateAddress({
      address: requestId,
      chainId: SPENDER_CHAIN_ID,
      family: "ethereum-vm",
    })
    const hubEthBalance = await relayChainClient.readContract({
      abi: RelayHub,
      address: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
      args: [orderAlias, ETH_TOKEN_ID],
      functionName: "balanceOf",
    })
    console.log(
      `request ${requestId} -> alias ${orderAlias} | hub ETH(${SPENDER_CHAIN_ID}) balance: ${hubEthBalance}`
    )
  }

  if (aliases.length === 0) {
    console.log("Nothing to do: every alias is already suspended")
    return
  }

  // Nonce increments across the batch since all txs share the same signer.
  const startNonce = await relayChainClient.getTransactionCount({
    address: signerAddress,
  })

  const txs = await Promise.all(
    aliases.map(async (spenderAlias, index) => {
      const calldata = encodeFunctionData({
        abi: RelayAllocator,
        args: [spenderAlias],
        functionName: "suspend",
      })

      // estimateGas also validates the call succeeds from the owner account.
      const gas = await relayChainClient.estimateGas({
        account: signerAddress,
        data: calldata,
        to: ALLOCATOR,
      })

      console.log(`✓ RelayAllocator.suspend(${spenderAlias})`)

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
        to: ALLOCATOR,
      }
    })
  )

  const path = getManifestPath(
    "suspend-spender-aliases",
    `arbitrum-${aliases.length}-spenders`
  )
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch(console.error)
