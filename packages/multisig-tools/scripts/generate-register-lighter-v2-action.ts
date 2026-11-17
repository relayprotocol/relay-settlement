/**
 * Registers the Lit Allocator `lighter-vm` v2 action on the Lit account
 * contract on Base and attaches it to the existing allocator group.
 *
 * The allocator setup script (`packages/lit-allocator/scripts/setup.ts`)
 * normally performs these writes itself, but the Lit account is owned by the
 * environment's RelayMultisigSigner-derived Base wallet, so the writes must be
 * relayed through the multisig. Nothing is removed: the v1 `lighter-vm`
 * action stays registered and permitted, and the existing usage key already
 * has execute access to the group. Two calls are emitted:
 *
 *   1. addAction(accountApiKeyHash, "allocator-<env>-action-lighter-vm-v2", …, actionHash)
 *   2. addActionToGroup(accountApiKeyHash, groupId, actionHash)
 *
 * The action hash is keccak256 of the bundle CID printed by
 * `yarn workspace @relay-protocol/lit-allocator setup -- --env <env> … --dry-run`
 * for `lighter-vm`. Re-run this generator whenever the Lighter environment
 * config changes (for example when a Robinhood Lighter API key is allowlisted),
 * since that changes the CID.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-lighter-v2-action.ts --env <dev|stag|prod> \
 *     > transactions/<env>/NNN-register-lighter-vm-v2-keyed-action-<env>-lit-allocator.json
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
  /** IPFS CID of the v2 `lighter-vm` bundle for this environment. */
  lighterV2Cid: string
}

const environments = {
  dev: {
    accountApiKeyHash:
      0x2a0065350f24490dcd6d9adfcbd327cd63dfbc6e4c002a96233ea77cbf326e77n,
    allocatorGroupId: 5n,
    // @relay-protocol/lit-actions 0.0.34, allocatorEnvs.dev.versions.v2 lighter-vm (Robinhood API key allowlisted)
    lighterV2Cid: "QmWjckuB56XcDTUWgE9wCpEDgyb1dQpFpGiNiBHGFffEKu",
    owner: getAddress("0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"),
  },
  prod: {
    accountApiKeyHash:
      0xd044d801565b110874c397c34b93eab4b3e15c5b8d4d334d3ff4cf6a07a2a78dn,
    allocatorGroupId: 1n,
    // @relay-protocol/lit-actions 0.0.35, allocatorEnvs.prod.versions.v2 lighter-vm (Robinhood API key allowlisted)
    lighterV2Cid: "QmfBhYj4cL1G9eX2MtisHZgW7vQnQ3RHMVuSMR5r6nnMGw",
    owner: getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A"),
  },
  stag: {
    accountApiKeyHash:
      0x675525400a7e8605214f5a5424b8af0d73a45cd9a68c64ad4f008c3346c2573cn,
    allocatorGroupId: 1n,
    // @relay-protocol/lit-actions 0.0.35, allocatorEnvs.stag.versions.v2 lighter-vm (Robinhood API key allowlisted)
    lighterV2Cid: "QmVEbLVWghoUj4voozkp46JpNm4RG9guJowQ2qgbJWUCfP",
    owner: getAddress("0x71d8bE89D9f2339F0FE9cBA39496C6C9cbFF9da6"),
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
  if (value !== "dev" && value !== "stag" && value !== "prod") {
    throw new Error("Pass --env dev, --env stag or --env prod")
  }
  return value
}

const main = async () => {
  const environment = parseEnvironment()
  const config = environments[environment]
  const client = createPublicClient({ transport: http(BASE_RPC) })
  const actionName = `allocator-${environment}-action-lighter-vm-v2`
  const actionHash = BigInt(keccak256(toBytes(config.lighterV2Cid)))

  const calls: Call[] = [
    {
      calldata: encodeFunctionData({
        abi: accountConfigAbi,
        args: [
          config.accountApiKeyHash,
          actionName,
          "Lit Allocator Lighter signing action",
          actionHash,
        ],
        functionName: "addAction",
      }),
      description: `register ${actionName} (${config.lighterV2Cid})`,
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
