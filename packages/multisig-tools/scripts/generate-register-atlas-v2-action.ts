/**
 * Registers the Lit Allocator `atlas-vm` v2 action on the Lit account contract
 * on Base and attaches it to the existing allocator group.
 *
 * The allocator setup script (`packages/lit-allocator/scripts/setup.ts`)
 * normally performs these writes itself, but the Lit account is owned by the
 * environment's RelayMultisigSigner-derived Base wallet, so the writes must be
 * relayed through the multisig. The existing usage key already has execute
 * access to the group. Two calls are emitted:
 *
 *   1. addAction(accountApiKeyHash, "allocator-<env>-action-atlas-vm-v2", …, actionHash)
 *   2. addActionToGroup(accountApiKeyHash, groupId, actionHash)
 *
 * The action hash is keccak256 of the bundle CID printed by
 * `yarn workspace @relay-protocol/lit-allocator setup -- --env <env> … --dry-run`
 * for `atlas-vm`. Only dev has an Atlas domain configured, so only dev is listed.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-atlas-v2-action.ts --env dev \
 *     > transactions/dev/NNN-register-atlas-vm-v2-action-dev-lit-allocator.json
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

interface EnvironmentConfig {
  /** RelayMultisigSigner-derived Base wallet that owns the Lit account. */
  owner: Address
  /** keccak256 of the Lit account API key. */
  accountApiKeyHash: bigint
  /** `allocator-<env>` group id on the Lit account contract. */
  allocatorGroupId: bigint
  /** IPFS CID of the v2 `atlas-vm` bundle for this environment. */
  atlasV2Cid: string
}

const environments = {
  dev: {
    accountApiKeyHash:
      0x2a0065350f24490dcd6d9adfcbd327cd63dfbc6e4c002a96233ea77cbf326e77n,
    allocatorGroupId: 5n,
    // @relay-protocol/lit-actions 0.0.37, allocatorEnvs.dev.versions.v2 atlas-vm
    atlasV2Cid: "QmZaMLghHFnquqLka2npvzySNnHvontvBi2DieJQXpnRYD",
    owner: getAddress("0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"),
  },
} satisfies Record<string, EnvironmentConfig>

const accountConfigAbi = parseAbi([
  "function addAction(uint256 accountApiKeyHash, string name, string description, uint256 actionHash)",
  "function addActionToGroup(uint256 apiKeyHash, uint256 groupId, uint256 action)",
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

const main = async () => {
  const environment = parseEnvironment()
  const config = environments[environment]
  const client = createPublicClient({ transport: http(BASE_RPC) })
  const actionName = `allocator-${environment}-action-atlas-vm-v2`
  const actionHash = BigInt(keccak256(toBytes(config.atlasV2Cid)))

  const calls: Call[] = [
    {
      calldata: encodeFunctionData({
        abi: accountConfigAbi,
        args: [
          config.accountApiKeyHash,
          actionName,
          "Lit Allocator Atlas signing action",
          actionHash,
        ],
        functionName: "addAction",
      }),
      description: `register ${actionName} (${config.atlasV2Cid})`,
      gasFallback: ADD_ACTION_GAS_FALLBACK,
    },
    {
      calldata: encodeFunctionData({
        abi: accountConfigAbi,
        args: [config.accountApiKeyHash, config.allocatorGroupId, actionHash],
        functionName: "addActionToGroup",
      }),
      description: `attach ${actionName} to allocator-${environment} (group ${config.allocatorGroupId})`,
      gasFallback: ADD_ACTION_TO_GROUP_GAS_FALLBACK,
    },
  ]

  const [fees, startingNonce, estimatedGas] = await Promise.all([
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: config.owner }),
    Promise.all(
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
    ),
  ])
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
