// ABOUTME generate a manifest that migrates DEV ownership/roles off the stag
// security council (and the raw deployer key) onto the dev security council,
// signed by the stag council via its RelayMultisigSigner.
//
// The dev Hub-chain contracts were bootstrapped with the STAG security council
// (0x71d8…9da6) holding ADMIN over Hub, RelayOracleV2, RelayExecutor,
// RelayGenericMapping and the oracle idempotency store, owning RelayPriceOracle,
// and being the sole owner of the protocol governance Safe. `verify-deployment`
// flags all of this because the dev env should be governed by the DEV security
// council (0x33eb…d2d7). This manifest, signed by the stag council, moves every
// authority the stag council still holds over to the dev council and drops the
// deployer key from the idempotency store.
//
// Every call is broadcast from the stag council's derived wallet on the dev
// relay chain (chainId 537724). Ordering matters: grants and the ownership
// transfers run first, deployer/stag revocations run last, and the stag council
// only relinquishes its own ADMIN_ROLE in the final calls so it retains the
// authority needed to perform every preceding revoke.
//
// NOTE: the dev RelayUsdRateLimiter's ADMIN_ROLE is held ONLY by the raw
// deployer key (0xf3d6…691e), not by the stag council. It is its own role admin,
// so only the deployer can rotate it — a plain EOA that the MPC signer cannot
// sign for, hence it cannot live in this manifest. After executing the manifest,
// run the `cast send` commands this script prints to hand that role to the dev
// council and drop the deployer.
//
// Env:
//   SIGNER  optional 0x address to use as `from` (the stag council wallet).
//           Defaults to the known stag council derived wallet.
//   RPC_URL optional dev relay chain RPC override.
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  concat,
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
} from "viem"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

// Dev relay (Hub) chain — the deployment lives on chainId 537724, which is not
// the `relay` network entry (that one is the prod relay chain, 537713).
const DEV_RELAY_RPC = process.env.RPC_URL ?? "https://rpc.testnet.relay.link"

// Stag security council derived wallet — current admin/owner of the dev
// contracts and the signer for every call in this manifest.
const STAG_COUNCIL = (process.env.SIGNER ??
  "0x71d8bE89D9f2339F0FE9cBA39496C6C9cbFF9da6") as `0x${string}`

// Dev security council derived wallet — the intended governor of the dev env.
const DEV_COUNCIL = "0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7" as const

// Raw deployer key to purge from every role it still holds.
const DEPLOYER = "0xf3d63166F0Ca56C3c1A3508FcE03Ff0Cf3Fb691e" as const

// Gnosis Safe sentinel used as the head of the owners linked list.
const SENTINEL_OWNERS = "0x0000000000000000000000000000000000000001" as const
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

const deployment = JSON.parse(
  readFileSync(
    join(__dirname, "../../../smart-contracts/deployments/contracts/dev.json"),
    "utf8"
  )
) as {
  core: Record<string, string> & {
    rateLimiter: { address: string; type: string }
  }
  pricingOracle: Record<string, string>
}

const role = (name: string) => keccak256(toHex(name))
const ADMIN_ROLE = role("ADMIN_ROLE")
const OPERATOR_ROLE = role("OPERATOR_ROLE")
const WRITE_ROLE = role("WRITE_ROLE")

const accessControlAbi = parseAbi([
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
])
const ownableAbi = parseAbi(["function transferOwnership(address newOwner)"])
const safeAbi = parseAbi([
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
])

type Call = { label: string; to: `0x${string}`; calldata: `0x${string}` }

const grant = (
  to: `0x${string}`,
  name: string,
  roleId: `0x${string}`,
  roleLabel: string,
  account: `0x${string}`,
  accountLabel: string
): Call => ({
  calldata: encodeFunctionData({
    abi: accessControlAbi,
    args: [roleId, account],
    functionName: "grantRole",
  }),
  label: `${name}.grantRole(${roleLabel}, ${accountLabel}=${account})`,
  to,
})

const revoke = (
  to: `0x${string}`,
  name: string,
  roleId: `0x${string}`,
  roleLabel: string,
  account: `0x${string}`,
  accountLabel: string
): Call => ({
  calldata: encodeFunctionData({
    abi: accessControlAbi,
    args: [roleId, account],
    functionName: "revokeRole",
  }),
  label: `${name}.revokeRole(${roleLabel}, ${accountLabel}=${account})`,
  to,
})

const buildCalls = (): Call[] => {
  const hub = deployment.core.hub as `0x${string}`
  const oracle = deployment.core.oracle as `0x${string}`
  const executor = deployment.core.executor as `0x${string}`
  const genericMapping = deployment.core.genericMapping as `0x${string}`
  const idempotencyStore = deployment.core
    .oracleIdempotencyStore as `0x${string}`
  const priceOracle = deployment.pricingOracle.priceOracle as `0x${string}`
  const protocolSafe = deployment.core.protocolSafe as `0x${string}`

  // Pre-validated Gnosis Safe signature: r = owner, s = 0, v = 1. Valid because
  // the stag council wallet (the Safe's sole owner) is also the executor, so
  // checkNSignatures short-circuits on `msg.sender == owner`.
  const prevalidatedSignature = concat([
    pad(STAG_COUNCIL, { size: 32 }),
    pad("0x", { size: 32 }),
    "0x01",
  ])
  const swapOwnerData = encodeFunctionData({
    abi: safeAbi,
    args: [SENTINEL_OWNERS, STAG_COUNCIL, DEV_COUNCIL],
    functionName: "swapOwner",
  })

  return [
    // 1. Grant the dev council every authority the stag council currently holds.
    grant(
      hub,
      "hub",
      OPERATOR_ROLE,
      "OPERATOR_ROLE",
      DEV_COUNCIL,
      "devCouncil"
    ),
    grant(hub, "hub", ADMIN_ROLE, "ADMIN_ROLE", DEV_COUNCIL, "devCouncil"),
    grant(
      oracle,
      "oracle",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      DEV_COUNCIL,
      "devCouncil"
    ),
    grant(
      executor,
      "executor",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      DEV_COUNCIL,
      "devCouncil"
    ),
    grant(
      genericMapping,
      "genericMapping",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      DEV_COUNCIL,
      "devCouncil"
    ),
    grant(
      idempotencyStore,
      "oracleIdempotencyStore",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      DEV_COUNCIL,
      "devCouncil"
    ),

    // 2. Move Ownable / Safe ownership to the dev council.
    {
      calldata: encodeFunctionData({
        abi: ownableAbi,
        args: [DEV_COUNCIL],
        functionName: "transferOwnership",
      }),
      label: `priceOracle.transferOwnership(devCouncil=${DEV_COUNCIL})`,
      to: priceOracle,
    },
    {
      calldata: encodeFunctionData({
        abi: safeAbi,
        args: [
          protocolSafe,
          0n,
          swapOwnerData,
          0,
          0n,
          0n,
          0n,
          ZERO_ADDRESS,
          ZERO_ADDRESS,
          prevalidatedSignature,
        ],
        functionName: "execTransaction",
      }),
      label: `protocolSafe.execTransaction(swapOwner(stagCouncil -> devCouncil=${DEV_COUNCIL}))`,
      to: protocolSafe,
    },

    // 3. Drop the raw deployer key from the idempotency store.
    revoke(
      idempotencyStore,
      "oracleIdempotencyStore",
      WRITE_ROLE,
      "WRITE_ROLE",
      DEPLOYER,
      "deployer"
    ),

    // 4. Revoke the stag council's non-admin role(s).
    revoke(
      hub,
      "hub",
      OPERATOR_ROLE,
      "OPERATOR_ROLE",
      STAG_COUNCIL,
      "stagCouncil"
    ),

    // 5. Finally, drop the stag council's ADMIN_ROLE everywhere. These run last
    //    so the stag council keeps the authority to perform the revokes above.
    revoke(
      idempotencyStore,
      "oracleIdempotencyStore",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      STAG_COUNCIL,
      "stagCouncil"
    ),
    revoke(
      genericMapping,
      "genericMapping",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      STAG_COUNCIL,
      "stagCouncil"
    ),
    revoke(
      executor,
      "executor",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      STAG_COUNCIL,
      "stagCouncil"
    ),
    revoke(
      oracle,
      "oracle",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      STAG_COUNCIL,
      "stagCouncil"
    ),
    revoke(hub, "hub", ADMIN_ROLE, "ADMIN_ROLE", STAG_COUNCIL, "stagCouncil"),
  ]
}

const main = async () => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(STAG_COUNCIL)) {
    throw new Error(`SIGNER is not a valid address: ${STAG_COUNCIL}`)
  }

  console.log(`dev relay chain rpc: ${DEV_RELAY_RPC}`)
  console.log(`signer (stag council): ${STAG_COUNCIL}`)
  console.log(`new governor (dev council): ${DEV_COUNCIL}`)

  const client = createPublicClient({ transport: http(DEV_RELAY_RPC) })
  const calls = buildCalls()

  // All calls broadcast from the same wallet, so they occupy consecutive nonces.
  const baseNonce = await client.getTransactionCount({ address: STAG_COUNCIL })
  const gasPrice = await client.getGasPrice()
  const maxFeePerGas = gasPrice > 0n ? gasPrice * 2n : 7n

  const txs = await Promise.all(
    calls.map(async (call, i) => {
      const gas = await client.estimateGas({
        account: STAG_COUNCIL,
        data: call.calldata,
        to: call.to,
      })
      console.log(`  [nonce ${baseNonce + i}] ${call.label}`)
      return {
        amount: "0",
        calldata: call.calldata,
        family: "ethereum-vm",
        from: STAG_COUNCIL,
        gas: ((gas * 12n) / 10n).toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: "0",
        nonce: baseNonce + i,
        rpc: DEV_RELAY_RPC,
        to: call.to,
      }
    })
  )

  const path = getManifestPath("migrate-dev-ownership", "stag-to-dev", "stag")
  writeFileSync(path, `${stringifyJsonWithBigInt(txs)}\n`)

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)

  // Follow-up: the rate limiter's ADMIN_ROLE is deployer-held, so it can't go in
  // the MPC-signed manifest above. Print the two deployer-signed calls to run
  // (in order) once the manifest has executed.
  const rateLimiter = deployment.core.rateLimiter.address as `0x${string}`
  const rateLimiterCalls: Call[] = [
    grant(
      rateLimiter,
      "rateLimiter",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      DEV_COUNCIL,
      "devCouncil"
    ),
    revoke(
      rateLimiter,
      "rateLimiter",
      ADMIN_ROLE,
      "ADMIN_ROLE",
      DEPLOYER,
      "deployer"
    ),
  ]
  console.log(
    `\n\u26a0\ufe0f  rateLimiter (${rateLimiter}) ADMIN_ROLE is held by the deployer only,`
  )
  console.log(
    "   so it is NOT in the manifest. Broadcast these two calls with the deployer"
  )
  console.log(
    "   key (grant the dev council first, then revoke the deployer):\n"
  )
  for (const call of rateLimiterCalls) {
    console.log(`   # ${call.label}`)
    console.log(
      `   cast send ${call.to} ${call.calldata} \\\n     --rpc-url ${DEV_RELAY_RPC} --private-key "$DEPLOYER_PRIVATE_KEY"\n`
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
