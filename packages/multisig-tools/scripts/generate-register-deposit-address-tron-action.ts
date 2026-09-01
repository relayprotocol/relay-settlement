/**
 * Registers the Tron Deposit Address action, attaches it to the existing
 * Deposit Address group, and grants the existing Lit Allocator usage keys
 * execute access to that group for staging or production.
 *
 * This does not mint or expose a usage API key. It preserves the key's
 * existing metadata, balance, expiration, and allocator-group permission.
 * The action hashes below come from the exact environment bundles published
 * in @relay-protocol/lit-actions@0.0.30.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-deposit-address-tron-action.ts --env stag \
 *     > transactions/stag/005-register-deposit-address-tron-action.json
 *
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-deposit-address-tron-action.ts --env prod \
 *     > transactions/prod/071-register-deposit-address-tron-action.json
 */
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem"

const BASE_RPC = "https://mainnet.base.org"
const ACCOUNT_CONFIG = getAddress("0xaAaAA9120fE271F653cfDb6bf400dB93D2DEa7Aa")
const ALLOCATOR_GROUP_ID = 1n
const DEPOSIT_ADDRESS_GROUP_ID = 2n
const ADD_ACTION_GAS_FALLBACK = 300_000n
const ADD_ACTION_TO_GROUP_GAS_FALLBACK = 200_000n
const SET_USAGE_KEY_GAS_FALLBACK = 200_000n

interface EnvironmentConfig {
  owner: Address
  accountApiKeyHash: bigint
  tronActionHash: bigint
  usageKeys: UsageKeyConfig[]
}

interface UsageKeyConfig {
  hash: bigint
  expiration: bigint
  name: string
}

const environments = {
  prod: {
    accountApiKeyHash:
      0xd044d801565b110874c397c34b93eab4b3e15c5b8d4d334d3ff4cf6a07a2a78dn,
    owner: getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A"),
    // QmRmypFmh1ERSG2F7skQRUj6yHr4jPjkYuVFheTyfC2DWc
    tronActionHash:
      0x957e99bdae149f145a1f397f5e85c80a2e05f70601a92cb26961c71eef44e9d2n,
    usageKeys: [
      {
        expiration: 2094564418n,
        hash: 0xadcd2e2c6c6b73c8d87c8eda305c99835d15e41ed7c018f41f7df5188e312132n,
        name: "allocator-prod-usage-key",
      },
      {
        expiration: 2095322277n,
        hash: 0xe3cf0f62bc7c5c865b6388407cae376310df430a74860ad0b689ea01e7d13c3cn,
        name: "allocator-prod-usage-key-2",
      },
    ],
  },
  stag: {
    accountApiKeyHash:
      0x675525400a7e8605214f5a5424b8af0d73a45cd9a68c64ad4f008c3346c2573cn,
    owner: getAddress("0x71d8bE89D9f2339F0FE9cBA39496C6C9cbFF9da6"),
    // QmeF6wMUgERnioADWke6w7ishyEsY6daNueM4UqKfsTLLJ
    tronActionHash:
      0x5101bae75107e57f63bf1cd1f62b8ffa562bb078630a078a78ce45bd889f92ffn,
    usageKeys: [
      {
        expiration: 2095743916n,
        hash: 0x71368b970e298302bc13c67d4a5dc0e9b4a19385092a68e96212316d5aa10d09n,
        name: "allocator-stag-usage-key",
      },
    ],
  },
} satisfies Record<string, EnvironmentConfig>

const accountConfigAbi = parseAbi([
  "function addAction(uint256 accountApiKeyHash, string name, string description, uint256 actionHash)",
  "function addActionToGroup(uint256 apiKeyHash, uint256 groupId, uint256 action)",
  "function setUsageApiKey(uint256 accountApiKeyHash, uint256 usageApiKeyHash, uint256 expiration, uint256 balance, string name, string description, bool createGroups, bool deleteGroups, bool createPKPs, uint256[] manageIPFSIdsInGroups, uint256[] addPkpToGroups, uint256[] removePkpFromGroups, uint256[] executeInGroups)",
])

interface Call {
  calldata: `0x${string}`
  description: string
  gasFallback: bigint
}

function parseEnvironment(): keyof typeof environments {
  const index = process.argv.indexOf("--env")
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value !== "stag" && value !== "prod") {
    throw new Error("Pass --env stag or --env prod")
  }
  return value
}

const main = async () => {
  const environment = parseEnvironment()
  const config = environments[environment]
  const client = createPublicClient({ transport: http(BASE_RPC) })
  const actionName = `deposit-address-${environment}-action-tron-vm`
  const calls: Call[] = [
    {
      calldata: encodeFunctionData({
        abi: accountConfigAbi,
        args: [
          config.accountApiKeyHash,
          actionName,
          "Lit Deposit Address signing action (tron-vm)",
          config.tronActionHash,
        ],
        functionName: "addAction",
      }),
      description: `register ${actionName}`,
      gasFallback: ADD_ACTION_GAS_FALLBACK,
    },
    {
      calldata: encodeFunctionData({
        abi: accountConfigAbi,
        args: [
          config.accountApiKeyHash,
          DEPOSIT_ADDRESS_GROUP_ID,
          config.tronActionHash,
        ],
        functionName: "addActionToGroup",
      }),
      description: `attach ${actionName} to deposit-address-${environment}`,
      gasFallback: ADD_ACTION_TO_GROUP_GAS_FALLBACK,
    },
    ...config.usageKeys.map(
      (usageKey): Call => ({
        calldata: encodeFunctionData({
          abi: accountConfigAbi,
          args: [
            config.accountApiKeyHash,
            usageKey.hash,
            usageKey.expiration,
            10_000_000n,
            usageKey.name,
            "Usage key for Lit Allocator",
            false,
            false,
            false,
            [],
            [],
            [],
            [ALLOCATOR_GROUP_ID, DEPOSIT_ADDRESS_GROUP_ID],
          ],
          functionName: "setUsageApiKey",
        }),
        description: `grant ${usageKey.name} execute access to deposit-address-${environment}`,
        gasFallback: SET_USAGE_KEY_GAS_FALLBACK,
      })
    ),
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
