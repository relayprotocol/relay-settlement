/**
 * Registers the Lit Deposit Address v1.1 actions (one per VM) on the Lit
 * account contract on Base and attaches each to the existing Deposit Address
 * group. The v1 actions stay registered, so the deposit-address service can
 * switch `LIT_ACTION_VERSION` between v1 and v1.1.
 *
 * The existing deposit-address usage key already has execute access to the
 * group. For each VM two calls are emitted:
 *
 *   1. addAction(accountApiKeyHash, "deposit-address-<env>-action-<vm>-v1.1", …, actionHash)
 *   2. addActionToGroup(accountApiKeyHash, groupId, actionHash)
 *
 * The action hashes are keccak256 of the CIDs of the v1.1 code in
 * @relay-protocol/lit-actions@0.0.38 for each environment.
 *
 * Usage:
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-deposit-address-v1-1-actions.ts --env <dev|stag|prod> \
 *     > transactions/<env>/<n>-register-deposit-address-v1-1-actions-<env>.json
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
const ACTION_VERSION = "v1.1"
const ADD_ACTION_GAS_FALLBACK = 300_000n
const ADD_ACTION_TO_GROUP_GAS_FALLBACK = 200_000n

type VmType =
  | "bitcoin-vm"
  | "ethereum-vm"
  | "hyperliquid-vm"
  | "solana-vm"
  | "ton-vm"
  | "tron-vm"

interface EnvironmentConfig {
  /** RelayMultisigSigner-derived Base wallet that owns the Lit account. */
  owner: Address
  /** keccak256 of the Lit account API key. */
  accountApiKeyHash: bigint
  /** `deposit-address-<env>` group id on the Lit account contract. */
  depositAddressGroupId: bigint
  /** keccak256 of each VM's v1.1 bundle CID for this environment. */
  actionHashes: Record<VmType, bigint>
}

const environments = {
  dev: {
    accountApiKeyHash:
      0x2a0065350f24490dcd6d9adfcbd327cd63dfbc6e4c002a96233ea77cbf326e77n,
    actionHashes: {
      // QmbXw7wmsyX9zbCEKu9BC2idPfHZF3D4iz34FXKY3ZkRQG
      "bitcoin-vm":
        0xad628365c1c0fd0c4fb60d7b9a18deb8e74a31411dfe924b1bed576fe791203bn,
      // QmTFEdUUjm5foSfZtfNCLmU6PbQP1xt3xYb8f3x2iZ1ir1
      "ethereum-vm":
        0x9f32102bbcf702cf4d5fea8b273be8433c2bec86dff45b8c85b474d5e8881525n,
      // Qmbxbb6Bud9UwSkNpqNNFwgVgaUqfNmrkeQPEKfY3ut6EU
      "hyperliquid-vm":
        0xccbfdccfff524020eb94bbcac6003c9e8eb5065f54513a944d2983f0d53c4627n,
      // QmWyG34zZs5GAiCq1JFcUXb84Xaez4ByfLekbtReJD3caQ
      "solana-vm":
        0xf74c0047bb6ed3739c6f00fa7097dce84d387ecce2d7a8e15bb0d5fe7c28788an,
      // QmdfGjuQjSMzaMLbwvtEy16JD3E1CPnyzmMMrZxtpz359N
      "ton-vm":
        0xf2ad9f106833edc20b609183535d7da50f04ec25f78e4c930e0a7ef1436b907cn,
      // Qmb87NJzHu1CMcQNYwbtDxD1ujuAzsYYMGsYvvd79FzpBD
      "tron-vm":
        0x56daf89696f210ef74ea7825aceaa8e81a2dab306b11a2cb2a3ed055a34c825en,
    },
    depositAddressGroupId: 6n,
    owner: getAddress("0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7"),
  },
  prod: {
    accountApiKeyHash:
      0xd044d801565b110874c397c34b93eab4b3e15c5b8d4d334d3ff4cf6a07a2a78dn,
    actionHashes: {
      // QmasKraHuPsUnDrj6i4azsTARvv1CqDyeUqcJGx6aEyYF4
      "bitcoin-vm":
        0x47b778463c2d4c8f2a89815a5e23fcb911dcc350ebaf07f7710788edc65e9385n,
      // QmULQTLifpy7LFVju8rd9JqEbkzp6GuNPMXHmSSUeyFKes
      "ethereum-vm":
        0xc95c437d3f9fb8d27e2b8fcfdbe2d72730a382e8732a23cfb13a9b179110f8cbn,
      // QmNbTnm3KzUCEMf8Ktw6j7SgZxBbGr75rZ3kEbZpi3qvcA
      "hyperliquid-vm":
        0x106e0d10540d12a3128cd86e95c59f5d1c84e293dc8b930d18daa5a3452558adn,
      // QmeQg1jfEY2Vcca9BxqDofEqWHDVzXp446C7mhyuTy9Xza
      "solana-vm":
        0xb8c04a07dd72e739eee0a539d0002114ff26d55bba7ff86c95782045e48e58c5n,
      // QmVFzsbNpxdQqMVFSF8aRvHkUi246Vd15fgGuxCdSZssvA
      "ton-vm":
        0xa004833263b11f7244be01d581541eb1a3cc092bf298bcc41286f8fa7b4d8ea6n,
      // QmQf8keTKeWYo4NqUtAJugfDWT7qPm6utEwkqVygeFAeoa
      "tron-vm":
        0x48002853cb25642de4cb9236021b5460f6494a44e40316d7e742f844a820f228n,
    },
    depositAddressGroupId: 2n,
    owner: getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A"),
  },
  stag: {
    accountApiKeyHash:
      0x675525400a7e8605214f5a5424b8af0d73a45cd9a68c64ad4f008c3346c2573cn,
    actionHashes: {
      // QmV4UksWi3jj1EC7EhLyUFvQL1KUtTFRUdRjxAmQ2YnycG
      "bitcoin-vm":
        0xee946bb7dd96eaebe5bb6f3fab2b7f78c1c2918ec8d40003e1ffb72b4505f726n,
      // QmS3w88wAPLg8nT2kHx1MkSddCwtxDMc2CAY19YispNKNY
      "ethereum-vm":
        0x6fac9439fe75a32400f2af410c52807c83be0798451ad0a469fc538a5ec93ea0n,
      // QmSzu5ZsMQL19MtWBAeir995jZSmPLCfyuKKbqf38RZeRf
      "hyperliquid-vm":
        0xe0ccb87c22b4669ac1eeea44a2a4e568a290a491388856ac715e8e514b0287b3n,
      // QmVCNoiowfG4P1CAHcdzPhCyJXmkVAGS96NAhtsFdYUcqW
      "solana-vm":
        0xffac7a649e46febf2e4ebd67aee4238c40dd28882b8ad3379701d77e17a61d1dn,
      // QmTrEDQS3NnZmoaAv9NX1C7L3T7XbEEn67MsCUgsPtQYNy
      "ton-vm":
        0xffe698e2be4241f601595ea2a8e85ab678cea9335c37fae3b0b2dd0b87960ba0n,
      // QmQfbwbrotxbZMSkeskWEh86YgVyAmNk171ZM66gcWBReh
      "tron-vm":
        0x92aa449eb0429fe127555f4482fe615183dfa9d094720c11477413bf551dfa34n,
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
