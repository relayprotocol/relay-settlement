// ABOUTME generate a manifest that freezes addresses on any supported chain by
// suspending their Hub aliases on the RelayAllocator (relay chain), to be
// submitted through RelayMultisigSigner.
//
// Each address is aliased with Utils.generateAddress(hubChainId, address), the
// same derivation the oracle uses to credit deposits and RelayAllocator applies
// to withdraw requests. Suspending the alias blocks allocator withdrawals that
// the alias itself spends, and nothing else. Payloads the allocator already
// signed are not cancelled.
//
// RelayExecutor holds the Hub operator role and can pull ANY account's balance,
// including a suspended alias or an order address, then withdraw it under its
// own "relay" alias. Each pull needs an oracle-signed execute-and-withdraw
// request; the current oracle only signs those against a solver-signed order
// and copies that order's deadline into the request, but the contract itself
// does not bound how long the oracle may keep signing. Stopping that path needs
// another lever (the oracle refusing to sign, or pause/pauseChains). Any other
// Hub OPERATOR_ROLE holder can also transferFrom a suspended alias directly.
//
// Deposits that carry an order id are credited to the order address instead of
// the depositor alias. Pass those ids with --deposit-id (with --token) to report
// that exposure. Only the current order-address derivation is probed: balances
// credited under the legacy scheme (helpers/legacyOrderAddress.ts) read as zero.
//
// The Hub chain id is the oracle's chain id for the chain (e.g. "tron" for
// Tron), which can differ from the networks package's hubChainId, so it must be
// passed explicitly. Using the wrong one suspends an unrelated alias, so the
// script also probes the other candidate ids and refuses to write the manifest
// when one of them holds Hub balances that the chosen id does not, unless
// --force is passed.
//
// suspend() is onlyOwner and the owner is the multisig signer EOA, so the calls
// cannot be batched through Multicall3 (msg.sender would become the Multicall3
// contract). We emit one transaction per alias instead, sharing the signer
// nonce sequence like the other relay-chain manifests.
//
// Example (DEC-2295, Tron depositors holding USDT):
//   yarn workspace @relay-settlement/multisig-tools tsx scripts/generate-suspend-addresses.ts \
//     --chain tron --hub-chain-id tron \
//     --address TGYx4neFLvi9TTNBUFoCoBn29UtihFT3rq TJzMDTqiuNdKKxmxF9qZoHm2EFwWiU4VPu \
//     --token TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
import { unlinkSync, writeFileSync } from "fs"
import { Command } from "commander"
import { encodeFunctionData, formatUnits, getAddress } from "viem"
import { RelayAllocator, RelayHub } from "@relay-protocol/settlement-abis"
import { networks } from "@relay-protocol/settlement-networks"
import {
  generateAddress,
  generateTokenId,
  getOrderAddress,
} from "@relay-protocol/settlement-sdk"
import {
  getSignerAddress,
  createRelayChainClient,
  RELAY_CHAIN_HUB_ADDRESS,
  RELAY_CHAIN_GAS_CONFIG,
} from "./helpers/chains"
import {
  describeNonceConflicts,
  findNonceConflicts,
} from "../src/helpers/nonceConflicts"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

// RelayAllocator on the relay chain (owner == multisig signer).
const ALLOCATOR = getAddress("0x613D3c588F6B8f89302b463F8F19f7241B2857E2")
const HUB = RELAY_CHAIN_HUB_ADDRESS as `0x${string}`

const main = async () => {
  const program = new Command()
  program
    .name("generate-suspend-addresses")
    .description(
      "Generate a manifest suspending the RelayAllocator aliases of addresses on a chain"
    )
    .requiredOption(
      "-c, --chain <slugOrChainId>",
      "Chain the addresses belong to (network slug or chain id)"
    )
    .requiredOption(
      "--hub-chain-id <id>",
      "Chain id the Hub keys accounts on, as configured in the oracle (e.g. tron)"
    )
    .requiredOption(
      "-a, --address <addresses...>",
      "Addresses to freeze, in the chain's native format"
    )
    .option(
      "-t, --token <tokens...>",
      "Token addresses on the chain whose Hub balances are reported for review",
      []
    )
    .option(
      "-d, --deposit-id <ids...>",
      "Order ids of depository deposits whose order-address Hub balances are reported for review (current derivation only; legacy order addresses are not probed)",
      []
    )
    .option(
      "--force",
      "Write the manifest without --token, or when another candidate hub chain id holds the reported balances",
      false
    )
    .parse(process.argv)

  const opts = program.opts<{
    address: string[]
    chain: string
    depositId: string[]
    force: boolean
    hubChainId: string
    token: string[]
  }>()

  const network = networks[opts.chain]
  if (!network) {
    throw new Error(`Unknown chain "${opts.chain}"`)
  }
  if (opts.depositId.length > 0 && opts.token.length === 0) {
    throw new Error("--deposit-id needs --token to report order balances")
  }
  if (opts.token.length === 0 && !opts.force) {
    throw new Error(
      "--token is needed to verify --hub-chain-id against Hub balances; pass --force to skip that check"
    )
  }
  const family = network.family
  const hubChainId = opts.hubChainId
  console.log(`Chain: ${network.slug} (${family}, hub chain id ${hubChainId})`)
  const networkHubChainId = network.hubChainId ?? network.chainId.toString()
  if (networkHubChainId !== hubChainId) {
    console.warn(
      `⚠️  --hub-chain-id ${hubChainId} differs from the networks package (${networkHubChainId}); check the aliases below against on-chain Hub activity`
    )
  }
  const candidateHubChainIds = [
    ...new Set([networkHubChainId, network.slug, network.chainId.toString()]),
  ].filter((candidate) => candidate !== hubChainId)

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

  const tokens = await Promise.all(
    [...new Set(opts.token)].map(async (address) => {
      const id = generateTokenId({ address, chainId: hubChainId, family })
      const decimals = await relayChainClient.readContract({
        abi: RelayHub,
        address: HUB,
        args: [id],
        functionName: "decimals",
      })
      return { address, decimals: Number(decimals), id }
    })
  )

  // A token's Hub supply only exists under the chain id the oracle keys it on,
  // which identifies a wrong --hub-chain-id even when the targets hold nothing.
  const readSupply = (address: string, chainId: string) =>
    relayChainClient.readContract({
      abi: RelayHub,
      address: HUB,
      args: [generateTokenId({ address, chainId, family })],
      functionName: "totalSupply",
    }) as Promise<bigint>
  // Refuse when a token's supply sits under another candidate id, or when no
  // token has supply under the chosen id; a token unminted everywhere only warns.
  const refuseUnlessForced = (message: string) => {
    if (!opts.force) {
      throw new Error(`${message}; check --hub-chain-id or pass --force`)
    }
    console.warn(`⚠️  ${message}; continuing because --force was passed`)
  }
  let hubChainIdConfirmed = false
  for (const token of tokens) {
    const supply = await readSupply(token.address, hubChainId)
    console.log(
      `${token.address} Hub supply under ${hubChainId}: ${formatUnits(supply, token.decimals)}`
    )
    if (supply > 0n) {
      hubChainIdConfirmed = true
      continue
    }
    let foundElsewhere = false
    for (const candidate of candidateHubChainIds) {
      if ((await readSupply(token.address, candidate)) === 0n) continue
      refuseUnlessForced(
        `${token.address} has Hub supply under hub chain id ${candidate} but none under ${hubChainId}`
      )
      foundElsewhere = true
      break
    }
    if (!foundElsewhere) {
      console.warn(
        `⚠️  ${token.address} has no Hub supply under ${hubChainId} or any candidate hub chain id`
      )
    }
  }
  if (tokens.length > 0 && !hubChainIdConfirmed) {
    refuseUnlessForced(
      `No --token has Hub supply under ${hubChainId}, so --hub-chain-id is unverified`
    )
  }

  // Token ids are keyed on the hub chain id too, so a candidate id must read
  // balances with its own token ids.
  const readBalances = (owner: `0x${string}`, chainId = hubChainId) =>
    Promise.all(
      tokens.map(
        (token) =>
          relayChainClient.readContract({
            abi: RelayHub,
            address: HUB,
            args: [
              owner,
              chainId === hubChainId
                ? token.id
                : generateTokenId({ address: token.address, chainId, family }),
            ],
            functionName: "balanceOf",
          }) as Promise<bigint>
      )
    )

  const formatBalances = (balances: bigint[], totals: bigint[]) =>
    tokens
      .map((token, index) => {
        totals[index] += balances[index]
        // Raw base units alongside: Hub decimals default to 18 when unset.
        return `${token.address}: ${formatUnits(balances[index], token.decimals)} (${balances[index]} raw)`
      })
      .join(", ")

  const printTotals = (label: string, totals: bigint[]) =>
    tokens.forEach((token, index) =>
      console.log(
        `Total ${label} hub balance ${token.address}: ${formatUnits(totals[index], token.decimals)} (${totals[index]} raw, ${token.decimals} decimals)`
      )
    )

  // Report-only: order-address balances for deposits that carry an order id.
  const orderTotals = tokens.map(() => 0n)
  for (const depositId of [...new Set(opts.depositId)]) {
    const orderAddress = getOrderAddress({ chainId: hubChainId, depositId })
    const balances = await readBalances(orderAddress)
    console.log(
      `deposit ${depositId} -> order ${orderAddress} | hub balances: ${formatBalances(balances, orderTotals)}`
    )
  }
  if (opts.depositId.length > 0) {
    printTotals("order", orderTotals)
    if (orderTotals.some((total) => total > 0n)) {
      console.warn(
        "⚠️  Order addresses hold Hub balances. Suspension does not freeze them: RelayExecutor can still withdraw them while the oracle signs execute-and-withdraw requests."
      )
    }
  }

  // Report each alias' current state so reviewers can reconcile the frozen
  // balances against the expected amounts.
  const aliases: { address: string; alias: `0x${string}` }[] = []
  const totals = tokens.map(() => 0n)
  for (const address of [...new Set(opts.address)]) {
    const alias = generateAddress({ address, chainId: hubChainId, family })

    const [alreadySuspended, balances] = await Promise.all([
      relayChainClient.readContract({
        abi: RelayAllocator,
        address: ALLOCATOR,
        args: [alias],
        functionName: "suspended",
      }),
      readBalances(alias),
    ])

    const balanceReport = formatBalances(balances, totals)

    console.log(
      `${address} -> alias ${alias} | suspended: ${alreadySuspended}${
        balanceReport ? ` | hub balances: ${balanceReport}` : ""
      }`
    )

    if (alreadySuspended) {
      console.log("  already suspended, skipping")
      continue
    }
    aliases.push({ address, alias })
  }

  printTotals("alias", totals)

  // A wrong hub chain id derives aliases that never hold funds. When another
  // candidate id's aliases hold balances and the chosen ones do not, refuse.
  if (tokens.length > 0 && totals.every((total) => total === 0n)) {
    for (const candidate of candidateHubChainIds) {
      const candidateTotals = tokens.map(() => 0n)
      for (const address of [...new Set(opts.address)]) {
        const alias = generateAddress({ address, chainId: candidate, family })
        const balances = await readBalances(alias, candidate)
        console.log(
          `  candidate hub chain id ${candidate}: ${address} -> alias ${alias} | hub balances: ${formatBalances(balances, candidateTotals)}`
        )
      }
      if (candidateTotals.some((total) => total > 0n)) {
        const message = `Aliases under hub chain id ${candidate} hold Hub balances while those under ${hubChainId} hold none`
        if (!opts.force) {
          throw new Error(`${message}; check --hub-chain-id or pass --force`)
        }
        console.warn(`⚠️  ${message}; continuing because --force was passed`)
      }
    }
  }

  if (aliases.length === 0) {
    console.log("Nothing to do: every alias is already suspended")
    return
  }

  // Nonce increments across the batch since all txs share the same signer.
  // Pending, so in-flight signer transactions are not reused.
  const startNonce = await relayChainClient.getTransactionCount({
    address: signerAddress,
    blockTag: "pending",
  })

  const txs = await Promise.all(
    aliases.map(async ({ address, alias }, index) => {
      const calldata = encodeFunctionData({
        abi: RelayAllocator,
        args: [alias],
        functionName: "suspend",
      })

      // estimateGas also validates the call succeeds from the owner account.
      const gas = await relayChainClient.estimateGas({
        account: signerAddress,
        data: calldata,
        to: ALLOCATOR,
      })

      console.log(`✓ RelayAllocator.suspend(${alias}) for ${address}`)

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
    `${network.slug}-${aliases.length}-addresses`
  )
  writeFileSync(path, stringifyJsonWithBigInt(txs))
  // Pending nonces miss manifests that are generated but not yet submitted.
  const conflicts = await findNonceConflicts(path)
  if (conflicts.length) {
    unlinkSync(path)
    throw new Error(`Nonce conflicts:\n${describeNonceConflicts(conflicts)}`)
  }

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
