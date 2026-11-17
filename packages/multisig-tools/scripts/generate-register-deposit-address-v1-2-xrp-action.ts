/**
 * Registers the Lit Deposit Address v1.2 xrp-vm action on the Lit account
 * contract on Base and attaches it to the existing Deposit Address group. The
 * other VMs' v1.2 bundles are unchanged and already attached. Earlier dev XRP
 * hashes stay registered; stag and prod have none.
 *
 * The existing deposit-address usage key already has execute access to the
 * group. Two calls are emitted:
 *
 *   1. addAction(accountApiKeyHash, "deposit-address-<env>-action-xrp-vm-v1.2", …, actionHash)
 *   2. addActionToGroup(accountApiKeyHash, groupId, actionHash)
 *
 * The action hashes are keccak256 of the CIDs of the v1.2 xrp-vm code in
 * @relay-protocol/lit-actions@0.0.46 for each environment.
 *
 * Set RELAY_NONCE_OFFSET to skip Base nonces held by unexecuted manifests.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-deposit-address-v1-2-xrp-action.ts --env <dev|stag|prod> \
 *     > transactions/<env>/<n>-register-deposit-address-v1-2-xrp-action-<env>.json
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
const ACTION_VERSION = "v1.2"
const ADD_ACTION_GAS_FALLBACK = 300_000n
const ADD_ACTION_TO_GROUP_GAS_FALLBACK = 200_000n

type VmType = "xrp-vm"

interface EnvironmentConfig {
  /** RelayMultisigSigner-derived Base wallet that owns the Lit account. */
  owner: Address
  /** keccak256 of the Lit account API key. */
  accountApiKeyHash: bigint
  /** `deposit-address-<env>` group id on the Lit account contract. */
  depositAddressGroupId: bigint
  /** keccak256 of the xrp-vm v1.2 bundle CID for this environment. */
  actionHashes: Record<VmType, bigint>
}

const environments = {
  dev: {
    accountApiKeyHash:
      0x2a0065350f24490dcd6d9adfcbd327cd63dfbc6e4c002a96233ea77cbf326e77n,
    actionHashes: {
      // QmcKrJ8EhZrQKhYvsAmo9nGZB4aPvLuvxkn6QY8PcD355o
      "xrp-vm":
        0xa10e25615769a5699587eeee2849757b6584627037b099909c9224604800b605n,
    },
    depositAddressGroupId: 6n,
    owner: getAddress("0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"),
  },
  prod: {
    accountApiKeyHash:
      0xd044d801565b110874c397c34b93eab4b3e15c5b8d4d334d3ff4cf6a07a2a78dn,
    actionHashes: {
      // QmfBJwkxWRq5Wr18hTtkEGxN2P1je5JTY2oarq3YUtWHCq
      "xrp-vm":
        0x56d687713056a49a6e41b37950c33a091570f52c5c7ffc73fd8c95f8a0f227bdn,
    },
    depositAddressGroupId: 2n,
    owner: getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A"),
  },
  stag: {
    accountApiKeyHash:
      0x675525400a7e8605214f5a5424b8af0d73a45cd9a68c64ad4f008c3346c2573cn,
    actionHashes: {
      // QmfZiuSXQFni4VYtNcVgmUXdms7rZcP8yjWzDB3DyorGuC
      "xrp-vm":
        0x5a0d8dd7dd78f26d33051fd7ef8628a3e4fcd9ea2042fc443a44b164e0603d05n,
    },
    depositAddressGroupId: 2n,
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
  if (value === undefined || !(value in environments)) {
    throw new Error("Pass --env dev|stag|prod")
  }
  return value as keyof typeof environments
}

const main = async () => {
  const environment = parseEnvironment()
  const config = environments[environment]
  const client = createPublicClient({ transport: http(BASE_RPC) })
  const groupName = `deposit-address-${environment}`

  const calls = Object.entries(config.actionHashes).flatMap(
    ([vmType, actionHash]): Call[] => {
      const actionName = `${groupName}-action-${vmType}-${ACTION_VERSION}`
      return [
        {
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
          description: `register ${actionName}`,
          gasFallback: ADD_ACTION_GAS_FALLBACK,
        },
        {
          calldata: encodeFunctionData({
            abi: accountConfigAbi,
            args: [
              config.accountApiKeyHash,
              config.depositAddressGroupId,
              actionHash,
            ],
            functionName: "addActionToGroup",
          }),
          description: `attach ${actionName} to ${groupName} (group ${config.depositAddressGroupId})`,
          gasFallback: ADD_ACTION_TO_GROUP_GAS_FALLBACK,
        },
      ]
    }
  )

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
