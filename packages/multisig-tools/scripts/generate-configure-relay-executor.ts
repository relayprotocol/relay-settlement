/**
 * Generates a multisig manifest that configures the prod RelayExecutor.
 *
 * The RelayExecutor verifies an oracle-signed ExecuteAndWithdrawRequest and then
 * pulls order funds, runs calls, and submits an allocator withdrawal. For that
 * to work two role grants are required (both sent by the relay-chain multisig
 * signer, which is ADMIN_ROLE on the executor and the hub):
 *
 *   1. executor.grantRole(ORACLE_ROLE, oracleMultisig)
 *        Authorizes the oracle whose EIP-1271 signature execute() checks. The
 *        oracle multisig already holds ORACLE_ROLE on the RelayOracle, so it is
 *        the canonical signing authority.
 *
 *   2. hub.grantRole(OPERATOR_ROLE, executor)
 *        Lets the executor pull order funds via transferFrom and act as the
 *        operator of its own "relay" spender alias when submitting the
 *        allocator withdrawal.
 *
 * The RelayAllocator already holds the hub OPERATOR_ROLE (so it can burn the
 * spender alias), and payload builders are configured separately, so no further
 * wiring is needed.
 *
 * Nonces start at the sender's on-chain transaction count plus
 * RELAY_NONCE_OFFSET, which accounts for relay-chain transactions from the same
 * signer that are queued in earlier manifests but not yet mined. Transaction
 * 052 (configure bitcoin/hyperliquid/lighter) queues 5 such transactions, so
 * this manifest is generated with RELAY_NONCE_OFFSET=5.
 *
 * Usage:
 *   RELAY_NONCE_OFFSET=5 \
 *   yarn workspace @relay-settlement/multisig-tools \
 *     tsx scripts/generate-configure-relay-executor.ts \
 *     > transactions/054-configure-relay-executor.json
 */
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
  type Hex,
} from "viem"

// --- Prod Relay Chain (537713) deployment -----------------------------------

const RELAY_RPC = "https://rpc.chain.relay.link"
// Prod RelayExecutor deployment (admin == multisig signer below).
const EXECUTOR = getAddress("0x49BC86FC092c1d66823A915EAf473cdf4324Bfb2")
const HUB = getAddress("0xDDD361727C22A01EB137880678A20b0BEaE69318")
// Oracle multisig: ORACLE_ROLE holder on the RelayOracle and EIP-1271 signer.
const ORACLE_MULTISIG = getAddress("0x2a72eb8CF0233a3dC6198683c83B1078dE6Fa2b0")
// ADMIN_ROLE on both executor and hub; sends these txs.
const FROM = getAddress("0xF61A305199fa1135d76FFaB3752D42F55cBd775A")

const ACCESS_CONTROL_ABI = parseAbi([
  "function grantRole(bytes32 role, address account)",
])

const ORACLE_ROLE = keccak256(toBytes("ORACLE_ROLE"))
const OPERATOR_ROLE = keccak256(toBytes("OPERATOR_ROLE"))

type Call = { description: string; to: Hex; calldata: Hex }

const grantRoleCall = (args: {
  to: Hex
  role: Hex
  account: Hex
  description: string
}): Call => ({
  calldata: encodeFunctionData({
    abi: ACCESS_CONTROL_ABI,
    args: [args.role, args.account],
    functionName: "grantRole",
  }),
  description: args.description,
  to: args.to,
})

const main = async () => {
  const client = createPublicClient({ transport: http(RELAY_RPC) })

  const calls: Call[] = [
    grantRoleCall({
      account: ORACLE_MULTISIG,
      description: `Executor.grantRole(ORACLE_ROLE, ${ORACLE_MULTISIG})`,
      role: ORACLE_ROLE,
      to: EXECUTOR,
    }),
    grantRoleCall({
      account: EXECUTOR,
      description: `Hub.grantRole(OPERATOR_ROLE, ${EXECUTOR})`,
      role: OPERATOR_ROLE,
      to: HUB,
    }),
  ]

  const fees = await client.estimateFeesPerGas()
  const nonceOffset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  let nonce =
    (await client.getTransactionCount({ address: FROM })) + nonceOffset

  const txs = []
  for (const call of calls) {
    // estimateGas also validates the call succeeds from the admin account.
    const gas = await client.estimateGas({
      account: FROM,
      data: call.calldata,
      to: call.to,
      value: parseEther("0"),
    })
    txs.push({
      amount: "0",
      calldata: call.calldata,
      family: "ethereum-vm",
      from: FROM,
      gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas!.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString(),
      nonce: nonce++,
      rpc: RELAY_RPC,
      to: call.to,
    })
    console.error(`✓ ${call.description}`)
  }

  console.log(JSON.stringify(txs, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
