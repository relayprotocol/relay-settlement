/**
 * Registers the rebuilt dev Lit Deposit Address v1.2 actions on the Lit account
 * contract on Base and attaches them to the existing deposit-address group.
 *
 * Dev v1.2 is rebuilt from source: it rejects `priceImpactBps` of 10000 on
 * every VM (#972) and widens the XRP sweep ledger window to 32 ledgers (#989).
 * The PKP and the usage key are kept, and the earlier v1.2 CIDs stay
 * registered and attached, so callers on an older package keep signing.
 *
 * For every VM whose CID is not yet registered (resp. attached), one call is
 * emitted:
 *
 *   addAction(accountApiKeyHash, "deposit-address-<env>-action-<vm>-v1.2", …, actionHash)
 *   addActionToGroup(accountApiKeyHash, groupId, actionHash)
 *
 * The action hash is keccak256 of the bundle CID, as computed by the Lit
 * `get_lit_action_ipfs_id` endpoint over the bundle that
 * `yarn workspace @relay-protocol/lit-deposit-address bundle:actions --env <env>`
 * writes. The account state is read on Base before emitting, so rerunning
 * after the manifest executed emits an empty batch.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-deposit-address-dev-v1-2-actions.ts --env dev \
 *     > transactions/dev/NNN-register-deposit-address-v1-2-rebuild-dev.json
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

interface EnvironmentConfig {
  /** RelayMultisigSigner-derived Base wallet that owns the Lit account. */
  owner: Address
  /** keccak256 of the Lit account API key. */
  accountApiKeyHash: bigint
  /** `deposit-address-<env>` group id on the Lit account contract. */
  depositAddressGroupId: bigint
  /** IPFS CID of each rebuilt v1.2 bundle for this environment. */
  cids: Record<string, string>
}

const environments = {
  dev: {
    accountApiKeyHash:
      0x2a0065350f24490dcd6d9adfcbd327cd63dfbc6e4c002a96233ea77cbf326e77n,
    // @relay-protocol/lit-actions 0.0.44, depositAddressEnvs.dev.versions["v1.2"]
    cids: {
      "bitcoin-vm": "QmVokdnsfMh4G9xRTxY5vnni37X2UhrzQ6xPKtLPeqrcV3",
      "ethereum-vm": "QmPRLzEWmJVx5ueLgQ74xfvkSKa71j8e6hR3fSmgwCNRkb",
      "hyperliquid-vm": "QmQNS7rkHbfH6mBZW1KYSxdYqXQ7biKw1934SgYLNHD2Yd",
      "solana-vm": "QmXDyC2xANK7ub3pPYdj5iZYZgVPzdqZeHsvC4ocXWGNSS",
      "ton-vm": "QmX1YyUcRSvrKDpEod5pENQstvtfiz4DY4wbvfCBurFdhy",
      "tron-vm": "QmXWNTdm4bQXLxCzrU88pePSaotniQps6p5tC2WBwAxS9T",
      "xrp-vm": "QmP35VVrREUaf5FUiSeS3NP4kif8FeJPxS8idSZNuXSXkU",
    },
    depositAddressGroupId: 6n,
    owner: getAddress("0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"),
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
  if (value !== "dev") {
    throw new Error("Pass --env dev")
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
        args: [
          config.accountApiKeyHash,
          config.depositAddressGroupId,
          0n,
          pageSize,
        ],
        functionName: "listActionsInGroup",
      })
    ),
  ])
  if (attached.size === 0) {
    throw new Error(
      `group ${config.depositAddressGroupId} has no actions; check the group id`
    )
  }

  const calls: Call[] = []
  for (const [vmType, cid] of Object.entries(config.cids)) {
    const actionName = `deposit-address-${environment}-action-${vmType}-v1.2`
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
            `Lit Deposit Address signing action (${vmType})`,
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
          args: [
            config.accountApiKeyHash,
            config.depositAddressGroupId,
            actionHash,
          ],
          functionName: "addActionToGroup",
        }),
        description: `attach ${actionName} to deposit-address-${environment} (group ${config.depositAddressGroupId})`,
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
