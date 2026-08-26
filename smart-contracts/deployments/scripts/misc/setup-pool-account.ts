#!/usr/bin/env ts-node
/**
 * Configure a RelayFundingPool account so a resolver can draw from it.
 *
 * A funded balance alone is not drawable. Two things gate every draw, both
 * keyed by the account and both settable only *by* that account:
 *
 *   sponsorshipResolvers[account][resolver]        which resolver may draw
 *   sponsorshipConfig[account][token]              authorizer, per-order cap,
 *                                                  budget, expiry
 *
 * An unset config means a zero per-order cap and no authorizer, so draws revert
 * — configuring is mandatory, not tuning.
 *
 * The authorizer is the key that signs off per order on the account's behalf
 * (DrawAuthorization{account, orderAddress}); canonically the platform's
 * operator key, so the account itself never has to be online per order. It
 * bounds nothing by amount — the cap, budget and balance do that — it states
 * which orders may draw the account at all. Setting it to the zero address
 * closes the token for draws without disturbing the other guardrails.
 *
 * This uses the account-signed EIP-712 path rather than transacting as the
 * account, so a sponsor never needs gas (or even a key that can transact) on
 * the hub chain: the account signs, anyone relays. ERC-1271 is supported
 * on-chain, so a Safe works as the account — supply its signature with
 * --resolver-signature / --config-signature instead of an account key.
 *
 * Usage:
 *   ts-node deployments/scripts/misc/setup-pool-account.ts --cap 0.01
 *   ts-node deployments/scripts/misc/setup-pool-account.ts --cap 0.01 --account 0xabc... \
 *     --resolver-signature 0x... --config-signature 0x... --nonce 7
 *
 * Options:
 *   --cap <value>         Per-order cap in human units (required), e.g. 0.01
 *   --budget <value>      Aggregate draw budget (default: unlimited). Spends down
 *                         and is not refilled by topping up the balance.
 *   --expiry <timestamp>  Unix timestamp after which draws are rejected (default: 0, never)
 *   --account <address>   Pool account (default: derived from ACCOUNT_PRIVATE_KEY)
 *   --resolver <address>  Resolver to allow (default: utils.poolDrawResolver)
 *   --authorizer <address>  Key authorizing this account's orders
 *                         (default: utils.poolDrawAuthorizer). The zero address
 *                         closes the token for draws.
 *   --pool <address>      Funding pool (default: utils.fundingPool)
 *   --env <name>          Deployment set: dev | stag | test | prod (default: dev)
 *   --chain <slug>        Origin chain slug for the token (default: base)
 *   --currency <address>  Origin currency (default: native, the zero address)
 *   --decimals <n>        Currency decimals for --cap/--budget (default: 18)
 *   --nonce <n>           First sponsorship nonce (default: first unused)
 *   --deadline <seconds>  Signature validity window (default: 3600)
 *   --resolver-signature <hex>  Pre-signed resolver update (for contract wallets)
 *   --config-signature <hex>    Pre-signed config update (for contract wallets)
 *   --print-messages      Print the messages to sign, then stop
 *   --dry-run             Print the plan, then stop
 *
 * Env vars:
 *   ACCOUNT_PRIVATE_KEY   The account's key — signs, never broadcasts. Optional
 *                         when both signatures are supplied.
 *   RELAYER_PRIVATE_KEY   Key that broadcasts (default: ACCOUNT_PRIVATE_KEY)
 *   RELAY_RPC_URL         Hub RPC (default: per-chain default below)
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
} from "viem"
import type { Address, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  fundingPoolSponsorshipConfigUpdateTypes,
  fundingPoolSponsorshipResolverUpdateTypes,
  generateTokenId,
  getFundingPoolSponsorshipConfigUpdateHash,
  getFundingPoolSponsorshipResolverUpdateHash,
} from "@relay-protocol/settlement-sdk"

const DEFAULT_RELAY_RPCS: Record<number, string> = {
  537713: "https://rpc.chain.relay.link",
  537724: "https://rpc.testnet.relay.link",
}

const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000" as Address

const hubAbi = parseAbi([
  "function erc20Views(uint256 tokenId) view returns (address)",
])

const poolAbi = parseAbi([
  "function sponsorshipConfig(address account, address token) view returns (uint256 perOrderCap, uint256 budget, address authorizer, uint64 expiry)",
  "function sponsorshipResolvers(address account, address resolver) view returns (bool)",
  "function usedSponsorshipNonces(address account, uint256 nonce) view returns (bool)",
  "function setSponsorshipResolver((address account, address resolver, bool allowed, uint256 nonce, uint256 deadline) update, bytes signature)",
  "function setSponsorshipConfig((address account, address token, address authorizer, uint256 perOrderCap, uint256 budget, uint64 expiry, uint256 nonce, uint256 deadline) update, bytes signature)",
])

type DeploymentFile = {
  chainId: number
  core: Record<string, string>
  utils?: Record<string, string>
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    return fallback
  }
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`)
  }
  return value
}

const flag = (name: string) => process.argv.includes(`--${name}`)

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required ${name}`)
  }
  return value
}

async function main() {
  const env = arg("env", "dev")!
  const chainSlug = arg("chain", "base")!
  const currency = (
    arg("currency", NATIVE_CURRENCY) as Address
  ).toLowerCase() as Address
  const decimals = Number(arg("decimals", "18"))
  const capInput = required("--cap", arg("cap"))
  const budgetInput = arg("budget")
  const expiry = BigInt(arg("expiry", "0")!)
  const deadlineWindow = BigInt(arg("deadline", "3600")!)
  const printMessages = flag("print-messages")
  const dryRun = flag("dry-run")

  const deploymentPath = join(__dirname, "..", "..", "contracts", `${env}.json`)
  if (!existsSync(deploymentPath)) {
    throw new Error(`Deployment file not found: ${deploymentPath}`)
  }
  const deployment: DeploymentFile = JSON.parse(
    readFileSync(deploymentPath, "utf8")
  )

  const hub = deployment.core.hub as Address
  const pool = (arg("pool", deployment.utils?.fundingPool) ??
    "") as `0x${string}`
  const resolver = (arg("resolver", deployment.utils?.poolDrawResolver) ??
    "") as Address
  if (!pool || !resolver) {
    throw new Error(
      "Missing pool or resolver: pass --pool / --resolver, or record them in the deployment set"
    )
  }

  // Whoever authorizes this account's orders. Defaults to the deployment set's
  // recorded operator key; there is deliberately no implicit fallback, since a
  // wrong authorizer silently makes every draw fail
  const authorizer = (arg("authorizer", deployment.utils?.poolDrawAuthorizer) ??
    "") as Address
  if (!authorizer) {
    throw new Error(
      "Missing authorizer: pass --authorizer, or record poolDrawAuthorizer in the deployment set. " +
        "Pass --authorizer 0x0000000000000000000000000000000000000000 to close the token for draws."
    )
  }

  // The account signs but never has to broadcast. When both signatures are
  // supplied the account key is not needed at all, which is the contract-wallet
  // (ERC-1271) path.
  const resolverSignatureArg = arg("resolver-signature") as Hex | undefined
  const configSignatureArg = arg("config-signature") as Hex | undefined
  const accountKey = process.env.ACCOUNT_PRIVATE_KEY
  const signer = accountKey
    ? privateKeyToAccount(
        (accountKey.startsWith("0x") ? accountKey : `0x${accountKey}`) as Hex
      )
    : undefined
  const account = (arg("account", signer?.address) ?? "") as Address
  if (!account) {
    throw new Error(
      "Missing account: set ACCOUNT_PRIVATE_KEY or pass --account"
    )
  }
  if (!signer && !(resolverSignatureArg && configSignatureArg)) {
    throw new Error(
      "Set ACCOUNT_PRIVATE_KEY, or supply both --resolver-signature and --config-signature"
    )
  }

  const relayRpc =
    process.env.RELAY_RPC_URL ?? DEFAULT_RELAY_RPCS[deployment.chainId]
  if (!relayRpc) {
    throw new Error(
      `No default hub RPC for chain ${deployment.chainId} — set RELAY_RPC_URL`
    )
  }
  const client = createPublicClient({ transport: http(relayRpc) })
  const liveChainId = await client.getChainId()
  if (liveChainId !== deployment.chainId) {
    throw new Error(
      `RPC serves chain ${liveChainId}, but ${env}.json declares ${deployment.chainId}`
    )
  }

  const hubTokenId = generateTokenId({
    address: currency,
    chainId: chainSlug,
    family: "ethereum-vm",
  })
  const token = (await client.readContract({
    abi: hubAbi,
    address: hub,
    args: [hubTokenId],
    functionName: "erc20Views",
  })) as Address
  if (token === NATIVE_CURRENCY) {
    throw new Error(
      `No ERC20View exists for ${chainSlug}/${currency} yet — it is created by the first mint`
    )
  }

  const perOrderCap = parseUnits(capInput, decimals)
  const budget = budgetInput ? parseUnits(budgetInput, decimals) : maxUint256

  // Both updates draw from one shared nonce space, so they need distinct
  // values; walk forward from the first unused one.
  let nonce = BigInt(arg("nonce", "0")!)
  for (;;) {
    const used = (await client.readContract({
      abi: poolAbi,
      address: pool,
      args: [account, nonce],
      functionName: "usedSponsorshipNonces",
    })) as boolean
    if (!used) {
      break
    }
    nonce += 1n
  }
  const resolverNonce = nonce
  const configNonce = nonce + 1n

  const latest = await client.getBlock()
  const deadline = latest.timestamp + deadlineWindow

  const resolverUpdate = {
    account,
    allowed: true,
    deadline,
    nonce: resolverNonce,
    resolver,
  }
  const configUpdate = {
    account,
    authorizer,
    budget,
    deadline,
    expiry,
    nonce: configNonce,
    perOrderCap,
    token,
  }

  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
  console.log(
    `Configuring pool account on ${env} (hub chain ${deployment.chainId})`
  )
  console.log(`  pool:          ${pool}`)
  console.log(`  account:       ${account}`)
  console.log(`  resolver:      ${resolver}`)
  console.log(`  token:         ${token} (${chainSlug}/${currency})`)
  console.log(`  authorizer:    ${authorizer}`)
  console.log(`  per-order cap: ${formatUnits(perOrderCap, decimals)}`)
  console.log(
    `  budget:        ${budget === maxUint256 ? "unlimited" : formatUnits(budget, decimals)}`
  )
  console.log(`  expiry:        ${expiry === 0n ? "never" : expiry}`)
  console.log(
    `  nonces:        ${resolverNonce} (resolver), ${configNonce} (config)`
  )
  console.log(`  deadline:      ${deadline}`)
  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )

  const resolverDigest = getFundingPoolSponsorshipResolverUpdateHash(
    deployment.chainId,
    pool,
    resolverUpdate
  )
  const configDigest = getFundingPoolSponsorshipConfigUpdateHash(
    deployment.chainId,
    pool,
    configUpdate
  )

  if (printMessages) {
    console.log("\nSponsorshipResolverUpdate")
    console.log(JSON.stringify(resolverUpdate, jsonBigint, 2))
    console.log(`  digest: ${resolverDigest}`)
    console.log("\nSponsorshipConfigUpdate")
    console.log(JSON.stringify(configUpdate, jsonBigint, 2))
    console.log(`  digest: ${configDigest}`)
    console.log(
      "\nHave the account sign these EIP-712 digests, then rerun with" +
        " --resolver-signature / --config-signature and the same --nonce."
    )
    return
  }
  if (dryRun) {
    console.log("\n--dry-run: stopping before any transaction")
    return
  }

  const domain = {
    chainId: deployment.chainId,
    name: "RelayFundingPool",
    verifyingContract: pool,
    version: "1",
  } as const

  const resolverSignature =
    resolverSignatureArg ??
    (await signer!.signTypedData({
      domain,
      message: resolverUpdate,
      primaryType: "SponsorshipResolverUpdate",
      types: fundingPoolSponsorshipResolverUpdateTypes,
    }))
  const configSignature =
    configSignatureArg ??
    (await signer!.signTypedData({
      domain,
      message: configUpdate,
      primaryType: "SponsorshipConfigUpdate",
      types: fundingPoolSponsorshipConfigUpdateTypes,
    }))

  // Anyone may broadcast an account-signed update, so the relayer is
  // deliberately allowed to differ from the account.
  const relayerKey =
    process.env.RELAYER_PRIVATE_KEY ?? process.env.ACCOUNT_PRIVATE_KEY
  if (!relayerKey) {
    throw new Error("Set RELAYER_PRIVATE_KEY to broadcast the signed updates")
  }
  const relayer = privateKeyToAccount(
    (relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`) as Hex
  )
  const wallet = createWalletClient({
    account: relayer,
    transport: http(relayRpc),
  })
  console.log(`\nRelaying as ${relayer.address}`)

  console.log("\n==> 1. Allowing the resolver to draw")
  const alreadyAllowed = (await client.readContract({
    abi: poolAbi,
    address: pool,
    args: [account, resolver],
    functionName: "sponsorshipResolvers",
  })) as boolean
  if (alreadyAllowed) {
    console.log("  ⏭️  already allowlisted")
  } else {
    const hash = await wallet.writeContract({
      abi: poolAbi,
      address: pool,
      args: [resolverUpdate, resolverSignature],
      chain: null,
      functionName: "setSponsorshipResolver",
    })
    await client.waitForTransactionReceipt({ hash })
    console.log(`  ✅ allowlisted in ${hash}`)
  }

  console.log("\n==> 2. Setting the draw guardrails")
  const hash = await wallet.writeContract({
    abi: poolAbi,
    address: pool,
    args: [configUpdate, configSignature],
    chain: null,
    functionName: "setSponsorshipConfig",
  })
  await client.waitForTransactionReceipt({ hash })
  console.log(`  ✅ configured in ${hash}`)

  console.log("\n==> 3. Final state")
  const allowed = (await client.readContract({
    abi: poolAbi,
    address: pool,
    args: [account, resolver],
    functionName: "sponsorshipResolvers",
  })) as boolean
  const [cap, storedBudget, storedAuthorizer, storedExpiry] =
    (await client.readContract({
      abi: poolAbi,
      address: pool,
      args: [account, token],
      functionName: "sponsorshipConfig",
    })) as [bigint, bigint, Address, bigint]
  console.log(`  resolver allowed: ${allowed}`)
  console.log(`  authorizer:       ${storedAuthorizer}`)
  console.log(`  per-order cap:    ${cap}`)
  console.log(
    `  budget:           ${storedBudget === maxUint256 ? "unlimited" : storedBudget}`
  )
  console.log(
    `  expiry:           ${storedExpiry === 0n ? "never" : storedExpiry}`
  )

  console.log(
    "\n════════════════════════════════════════════════════════════════════════"
  )
  if (allowed && cap > 0n) {
    console.log("✅ Account configured — fund it with fund-pool-account.ts")
  } else {
    console.log("⚠️  Account is not fully configured")
    process.exitCode = 1
  }
  console.log(
    "════════════════════════════════════════════════════════════════════════"
  )
}

const jsonBigint = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
