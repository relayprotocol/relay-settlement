/**
 * Register the dev XRP v1.2 deposit-address action and attach it to the existing
 * deposit-address-dev group, preserving its PKP and usage-key permissions.
 *
 * CID from the dev bundle at 2254bb40 (lit-actions 0.0.41 source), resolved with
 * Lit's /core/v1/get_lit_action_ipfs_id helper. Bundle SHA-256:
 * 2b644602435d11289075ad717afa1a2f29ebdad307639105da37f214d7bfde40
 *
 * Run from the repository root:
 *   yarn workspace @relay-settlement/multisig-tools tsx \
 *     scripts/generate-register-deposit-address-xrp-action.ts \
 *     > packages/multisig-tools/transactions/dev/020-register-deposit-address-xrp-action-dev.json
 */
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem"

const BASE_RPC = "https://mainnet.base.org"
const ACCOUNT_CONFIG = getAddress("0xaAaAA9120fE271F653cfDb6bf400dB93D2DEa7Aa")
const OWNER = getAddress("0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7")
const ACCOUNT_API_KEY_HASH =
  0x2a0065350f24490dcd6d9adfcbd327cd63dfbc6e4c002a96233ea77cbf326e77n
const GROUP_ID = 6n
const ACTION_NAME = "deposit-address-dev-action-xrp-vm-v1.2"
const ACTION_CID = "QmUb5KDUXf4rdyNGXHs56Woz1FZBZcgSX5eHuYF5Se76Mb"
const ACTION_HASH = BigInt(keccak256(stringToHex(ACTION_CID)))

const accountConfigAbi = parseAbi([
  "function addAction(uint256 accountApiKeyHash, string name, string description, uint256 actionHash)",
  "function addActionToGroup(uint256 apiKeyHash, uint256 groupId, uint256 action)",
  "function listGroups(uint256 accountApiKeyHash, uint256 pageNumber, uint256 pageSize) view returns ((uint256 id, string name, string description)[])",
])

const main = async () => {
  const nonceOffset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  if (!Number.isSafeInteger(nonceOffset) || nonceOffset < 0) {
    throw new Error("RELAY_NONCE_OFFSET must be a non-negative safe integer")
  }

  const client = createPublicClient({ transport: http(BASE_RPC) })
  const groups = await client.readContract({
    abi: accountConfigAbi,
    address: ACCOUNT_CONFIG,
    args: [ACCOUNT_API_KEY_HASH, 0n, 100n],
    functionName: "listGroups",
  })
  if (
    !groups.some(
      (group) => group.id === GROUP_ID && group.name === "deposit-address-dev"
    )
  ) {
    throw new Error(
      "Expected deposit-address-dev group 6 on the dev Lit account"
    )
  }

  const calls = [
    encodeFunctionData({
      abi: accountConfigAbi,
      args: [
        ACCOUNT_API_KEY_HASH,
        ACTION_NAME,
        "Lit Deposit Address signing action (xrp-vm)",
        ACTION_HASH,
      ],
      functionName: "addAction",
    }),
    encodeFunctionData({
      abi: accountConfigAbi,
      args: [ACCOUNT_API_KEY_HASH, GROUP_ID, ACTION_HASH],
      functionName: "addActionToGroup",
    }),
  ]
  const [fees, startingNonce, estimatedGas] = await Promise.all([
    client.estimateFeesPerGas(),
    client.getTransactionCount({ address: OWNER }),
    Promise.all(
      calls.map((calldata) =>
        client.estimateGas({
          account: OWNER,
          data: calldata,
          to: ACCOUNT_CONFIG,
        })
      )
    ),
  ])
  const transactions = calls.map((calldata, index) => ({
    amount: "0",
    calldata,
    family: "ethereum-vm",
    from: OWNER,
    gas: ((estimatedGas[index] * 110n) / 100n).toString(),
    maxFeePerGas: fees.maxFeePerGas!.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString(),
    nonce: startingNonce + nonceOffset + index,
    rpc: BASE_RPC,
    to: ACCOUNT_CONFIG,
  }))

  console.error(`Register ${ACTION_NAME}: ${ACTION_CID}`)
  console.error(`Attach to deposit-address-dev (group ${GROUP_ID})`)
  console.log(JSON.stringify(transactions, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
