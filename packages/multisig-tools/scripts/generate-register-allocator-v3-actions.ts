/**
 * Registers the Lit Allocator v3 actions on the Lit account contract on Base
 * and attaches them to the existing allocator group.
 *
 * v3 is the allocator action version that signs for an environment's
 * redeployed allocator (DEC-1891); v2 keeps signing for the previous one, and
 * callers pick the version by the allocator a withdrawal was submitted to.
 *
 * The allocator setup script (`packages/lit-allocator/scripts/setup.ts
 * --calldata --pkp-id <existing>`) emits the same writes, but the Lit account
 * is owned by the environment's RelayMultisigSigner-derived Base wallet, so
 * they are relayed through the multisig. The PKP and the usage key are kept:
 * the derived wallets do not change and the usage key already has execute
 * access to the group. The v1/v2 actions stay registered and attached, so
 * withdrawals on the previous allocator keep being signed.
 *
 * For every VM whose CID is not yet registered (resp. attached), one call is
 * emitted:
 *
 *   addAction(accountApiKeyHash, "allocator-<env>-action-<vm>-v3", …, actionHash)
 *   addActionToGroup(accountApiKeyHash, groupId, actionHash)
 *
 * The action hash is keccak256 of the bundle CID, as computed by the Lit
 * `get_lit_action_ipfs_id` endpoint over the bundle that
 * `yarn workspace @relay-protocol/lit-allocator bundle:actions --env <env>`
 * writes. The account state is read on Base before emitting, so rerunning
 * after the manifest executed emits an empty batch.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-allocator-v3-actions.ts --env <dev|stag|prod> \
 *     > transactions/<env>/NNN-register-allocator-v3-actions-<env>.json
 */
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
} from "viem"

const BASE_RPC = "https://mainnet.base.org"
const ACCOUNT_CONFIG = getAddress("0xaAaAA9120fE271F653cfDb6bf400dB93D2DEa7Aa")
const ADD_ACTION_GAS_FALLBACK = 300_000n
const ADD_ACTION_TO_GROUP_GAS_FALLBACK = 200_000n
const PAGE_SIZE = 100n

/** Description setup.ts registers for each VM's action. */
const ACTION_DESCRIPTIONS: Record<string, string> = {
  "atlas-vm": "Lit Allocator Atlas signing action",
  "bitcoin-vm": "Lit Allocator Bitcoin signing action",
  "ethereum-vm": "Lit Allocator Ethereum signing action",
  "gateway-vm": "Lit Allocator Circle Gateway signing action",
  "hedera-vm": "Lit Allocator Hedera signing action",
  "hyperliquid-vm": "Lit Allocator Hyperliquid signing action",
  "lighter-vm": "Lit Allocator Lighter signing action",
  "solana-vm": "Lit Allocator Solana signing action",
  "ton-vm": "Lit Allocator TON signing action",
  "tron-vm": "Lit Allocator Tron signing action",
  "xrp-vm": "Lit Allocator XRP signing action",
}

interface EnvironmentConfig {
  /** RelayMultisigSigner-derived Base wallet that owns the Lit account. */
  owner: Address
  /** keccak256 of the Lit account API key. */
  accountApiKeyHash: bigint
  /** `allocator-<env>` group id on the Lit account contract. */
  allocatorGroupId: bigint
  /** IPFS CID of each v3 bundle for this environment. */
  cids: Record<string, string>
}

const environments = {
  dev: {
    accountApiKeyHash:
      0x2a0065350f24490dcd6d9adfcbd327cd63dfbc6e4c002a96233ea77cbf326e77n,
    allocatorGroupId: 5n,
    // lit-allocator dev bundles for the redeployed allocator 0xCa65…bBB1
    // (DEC-2424); @relay-protocol/lit-actions 0.0.42, allocatorEnvs.dev.versions.v3
    cids: {
      "atlas-vm": "QmZxDwvSKuzrvQ5g3FU4AUKeYDSkwfJ6KSBLv5GGEoCpsT",
      "bitcoin-vm": "QmR5F9u235rKFQHu6VF9df3oS474371hGPgdxNZ9rZF2oL",
      "ethereum-vm": "QmWCfPTEf1443VFRNZfQPtdAssYFGMjWv81BNaB5G5Skdt",
      "gateway-vm": "QmZG73k1nKwa1uCaVcSVUFZhuemhVbVnBfRMBbTHBqzc2L",
      "hedera-vm": "QmXmkgC2SuevgmRAHFshBRZNZCgRtJXH3NuRPjgTWHtxR1",
      "hyperliquid-vm": "QmPNLTHGBzVV87N2o79B8RYxxerZ8RVb6UDgv3po6QFuiD",
      "lighter-vm": "QmdvEE4B7mqUcGGy8kcHTDUARokUUXyHyeEVcqyGnsxiTo",
      "solana-vm": "QmPbUqxNfMtPM7CrCDw9H5TmCDWdiJJ1MLqeF9jipL68Bo",
      "ton-vm": "QmSRo6gUJsbodWrKoupjRremb1PNdcMkSUCwXZGy7TQWAo",
      "tron-vm": "QmS4zvwMQtRwK58YRuvup31gnh2CZnLdy74wNdehseULRW",
      "xrp-vm": "QmP7JmvxqDUYBQu2w4GqnKdjrfoqyAMPKFAae8JyRy5gS8",
    },
    owner: getAddress("0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"),
  },
  prod: {
    accountApiKeyHash:
      0xd044d801565b110874c397c34b93eab4b3e15c5b8d4d334d3ff4cf6a07a2a78dn,
    allocatorGroupId: 1n,
    // lit-allocator prod bundles for the redeployed allocator 0xa68d…38C8
    // (DEC-2469); @relay-protocol/lit-actions 0.0.50, allocatorEnvs.prod.versions.v3
    cids: {
      "atlas-vm": "QmdHqydjMugNHBTGtnLjVvBhi34dkTMpkYG9XTLorbv9Y8",
      "bitcoin-vm": "QmS5eJ2A9jm2oaLaCoTNKy9BnijF6rZ4Hn5tGPPaqbH7Hn",
      "ethereum-vm": "QmWetzzbqpLSucdk15un15a4CJdUkAeaenMzrgfLfYhdQq",
      "gateway-vm": "QmNiLMKYez94TYDzC3eKX2S6GVbnzQnu2ZejTFjeQhhiLF",
      "hedera-vm": "QmRaGxdK8KJeuT3AfvQf5yLQzXZdGenhE5tkUFFkMLw8qK",
      "hyperliquid-vm": "QmZLxv7hZKUHfMv53zDv8wnXzRb2LgVCews8XoFSWfi44j",
      "lighter-vm": "QmR1k1rBpuNFeSJmgaXQ1hDuMsdFFgSiopcYDqGadFipJq",
      "solana-vm": "QmfMFPeCk5dMzs78VKQz38Q5nGZiSd6feCX3tk173PYENx",
      "ton-vm": "QmXGAYrgh4rsFgmS4UKWJPkVRTPn7D9bsyL6urMzxw4oAg",
      "tron-vm": "QmWBPs972dLjCd5LgvKvP2YX1hZNgCKQuPYTKr2pXMVcGK",
      "xrp-vm": "QmdHPW3ZobJ7oVkaEK7hDd8aPKqxe72pH8UCQedSkiy2U9",
    },
    owner: getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A"),
  },
  stag: {
    accountApiKeyHash:
      0x675525400a7e8605214f5a5424b8af0d73a45cd9a68c64ad4f008c3346c2573cn,
    allocatorGroupId: 1n,
    // lit-allocator stag bundles for the redeployed allocator 0xfe20…23FA
    // (DEC-2540); @relay-protocol/lit-actions 0.0.48, allocatorEnvs.stag.versions.v3
    cids: {
      "atlas-vm": "QmYkac8sQRYbfvWzCX765KwcDrNRU5WAcPSaJ1TFRyFvsu",
      "bitcoin-vm": "QmTycimeMjWhnzAzRya6s61WiXdh4n8A4d345Dw4XDEEXe",
      "ethereum-vm": "QmcV46AY7YYSP6yqewdjd679VHraYMHE1s7ovDoCh7bZWH",
      "gateway-vm": "QmWcLo8gRbKpKHeABVJdisVzJdebh9boq3TD1YrrgCnXC4",
      "hedera-vm": "QmNZmZmjxdGHZhmFmTSrAnvYwqCNZRzrDhSdbFe2g3hs2R",
      "hyperliquid-vm": "QmZeVM1bXsereWGujBDPz1eZDVPFJ9RGFaSeGVfjTf5JSV",
      "lighter-vm": "QmbD9svenLtRmM83EuWurMu9YwzcR6KKVAsHKUh8i5MKMh",
      "solana-vm": "QmeemB28iRUTinYTwXeM8xZc26GwAJCUypCczFA9qVv7tz",
      "ton-vm": "QmYSfMhdY5sToJQA6qgEgwFzXG9dtzQfrSjudCU3EYoPBh",
      "tron-vm": "QmXsNMQaNbpC3DRrrdUBMPLaD5kZWJaTVavvuDmuQvSMYN",
      "xrp-vm": "QmSZrGB8be1zhQorDRXZY6dT7X4Zd6xs3ScUUhwGzo8iah",
    },
    owner: getAddress("0x71d8bE89D9f2339F0FE9cBA39496C6C9cbFF9da6"),
  },
} satisfies Record<string, EnvironmentConfig>

const accountConfigAbi = parseAbi([
  "function addAction(uint256 accountApiKeyHash, string name, string description, uint256 actionHash)",
  "function addActionToGroup(uint256 apiKeyHash, uint256 groupId, uint256 action)",
  "function listActions(uint256 accountApiKeyHash, uint256 pageNumber, uint256 pageSize) view returns ((uint256 id, string name, string description)[])",
  "function listActionsInGroup(uint256 accountApiKeyHash, uint256 groupId, uint256 pageNumber, uint256 pageSize) view returns ((uint256 id, string name, string description)[])",
])

interface Call {
  calldata: `0x${string}`
  description: string
  gasFallback: bigint
}

function parseEnvironment(): keyof typeof environments {
  const index = process.argv.indexOf("--env")
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value !== "dev" && value !== "stag" && value !== "prod") {
    throw new Error("Pass --env dev, --env stag or --env prod")
  }
  return value
}

/**
 * Read every non-tombstoned action hash of a list view. The contract ignores
 * `pageNumber` and returns up to `pageSize` items in one call (see `readAll` in
 * lit-helpers' backend-chain-secured.ts), so issue one call and widen the page
 * size while it comes back full.
 */
async function readActionHashes(
  read: (_pageSize: bigint) => Promise<readonly { id: bigint }[]>
): Promise<Set<bigint>> {
  let pageSize = PAGE_SIZE
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await read(pageSize)
    if (BigInt(rows.length) < pageSize) {
      return new Set(rows.filter((row) => row.id !== 0n).map((row) => row.id))
    }
    pageSize *= 4n
  }
  throw new Error(
    `readActionHashes exceeded 5 widen attempts at pageSize=${pageSize}`
  )
}

const main = async () => {
  const environment = parseEnvironment()
  const config = environments[environment]
  const client = createPublicClient({ transport: http(BASE_RPC) })

  const [registered, attached] = await Promise.all([
    readActionHashes((pageSize) =>
      client.readContract({
        abi: accountConfigAbi,
        address: ACCOUNT_CONFIG,
        args: [config.accountApiKeyHash, 0n, pageSize],
        functionName: "listActions",
      })
    ),
    readActionHashes((pageSize) =>
      client.readContract({
        abi: accountConfigAbi,
        address: ACCOUNT_CONFIG,
        args: [config.accountApiKeyHash, config.allocatorGroupId, 0n, pageSize],
        functionName: "listActionsInGroup",
      })
    ),
  ])
  if (attached.size === 0) {
    throw new Error(
      `group ${config.allocatorGroupId} has no actions; check the group id`
    )
  }

  const calls: Call[] = []
  for (const [vmType, cid] of Object.entries(config.cids)) {
    const actionName = `allocator-${environment}-action-${vmType}-v3`
    const actionHash = BigInt(keccak256(toBytes(cid)))
    if (registered.has(actionHash)) {
      console.error(`${vmType}: ${cid} already registered`)
    } else {
      calls.push({
        calldata: encodeFunctionData({
          abi: accountConfigAbi,
          args: [
            config.accountApiKeyHash,
            actionName,
            ACTION_DESCRIPTIONS[vmType],
            actionHash,
          ],
          functionName: "addAction",
        }),
        description: `register ${actionName} (${cid})`,
        gasFallback: ADD_ACTION_GAS_FALLBACK,
      })
    }
    if (attached.has(actionHash)) {
      console.error(`${vmType}: ${cid} already attached`)
    } else {
      calls.push({
        calldata: encodeFunctionData({
          abi: accountConfigAbi,
          args: [config.accountApiKeyHash, config.allocatorGroupId, actionHash],
          functionName: "addActionToGroup",
        }),
        description: `attach ${actionName} to allocator-${environment} (group ${config.allocatorGroupId})`,
        gasFallback: ADD_ACTION_TO_GROUP_GAS_FALLBACK,
      })
    }
  }

  const [fees, startingNonce] = await Promise.all([
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: config.owner }),
  ])
  // Later calls depend on earlier ones (an action must exist before it is
  // attached), so estimates against current state may fail; fall back then.
  const estimatedGas = await Promise.all(
    calls.map(async (call) => {
      try {
        return await client.estimateGas({
          account: config.owner,
          data: call.calldata,
          to: ACCOUNT_CONFIG,
        })
      } catch {
        console.error(
          `Could not estimate ${call.description}; using fallback ${call.gasFallback}`
        )
        return call.gasFallback
      }
    })
  )
  const nonceOffset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  const transactions = calls.map((call, index) => ({
    amount: "0",
    calldata: call.calldata,
    family: "ethereum-vm",
    from: config.owner,
    gas: ((estimatedGas[index] * 110n) / 100n).toString(),
    maxFeePerGas: fees.maxFeePerGas!.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString(),
    nonce: startingNonce + nonceOffset + index,
    rpc: BASE_RPC,
    to: ACCOUNT_CONFIG,
  }))

  for (const call of calls) {
    console.error(call.description)
  }
  console.log(JSON.stringify(transactions, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
