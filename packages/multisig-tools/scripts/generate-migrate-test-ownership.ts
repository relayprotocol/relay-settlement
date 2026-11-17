// ABOUTME: Generates the dev-council manifest that hands the test env (Arbitrum
// ABOUTME: Sepolia Hub + testnet depositories) to the dedicated test signer.
//
// The test deployment was first handed from the deployer EOA to the dev
// council (0x33eB…D2d7). The test env now has its own RelayMultisigSigner on
// Aurora, so this manifest — signed by the dev council — moves everything the
// dev council holds over to the test council (the test signer's derived EVM
// wallet):
//
//   Arbitrum Sepolia: grant ADMIN_ROLE on hub/oracle/executor/genericMapping,
//                     transfer the RelayAllocator, then revoke the dev council's
//                     ADMIN_ROLE last so it keeps authority for every prior call.
//   Sepolia, Base Sepolia: transfer the RelayDepository.
//
// RelayInboxMultisig is Ownable2Step and is still owned by the deployer with a
// pending transfer to the dev council. The deployer re-points it at the test
// council (the cast command is printed), and this script also writes the
// test-env manifest in which the test council accepts it.
//
// Env:
//   TEST_COUNCIL  required 0x address: the test signer's derived EVM wallet
//                 (`scripts/derive-signer-address.ts --family ethereum-vm --env test`).
//                 Cross-checked against a fresh derivation from the Aurora config.
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { networks } from "@relay-protocol/settlement-networks"
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
} from "viem"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

const DEV_COUNCIL = "0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7" as const
const DEPLOYER = "0x28c50F9329D14b1eE7a3A38A2064e2348950d6B3" as const

const ARBITRUM_SEPOLIA_RPC = networks["421614"].rpc[0]
const TESTNET_DEPOSITORY = "0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3" as const
const DEPOSITORY_RPCS = {
  "base-sepolia": networks["84532"].rpc[0],
  sepolia: networks["11155111"].rpc[0],
}

const ADMIN_ROLE = keccak256(toHex("ADMIN_ROLE"))

const accessControlAbi = parseAbi([
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
])
const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
])

const deployment = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../contracts/relay-chain/deployments/contracts/test.json"
    ),
    "utf8"
  )
) as { core: Record<string, `0x${string}`> }

type Call = { label: string; to: `0x${string}`; calldata: `0x${string}` }

// Testnet base fees swing by orders of magnitude between approval and
// execution; a floor keeps the approved cap from going stale.
const MIN_MAX_FEE_PER_GAS = 1_000_000_000n

const feeCap = (gasPrice: bigint, multiplier: bigint) =>
  gasPrice * multiplier > MIN_MAX_FEE_PER_GAS
    ? gasPrice * multiplier
    : MIN_MAX_FEE_PER_GAS

const role = (
  functionName: "grantRole" | "revokeRole",
  name: string,
  account: `0x${string}`,
  accountLabel: string
): Call => ({
  calldata: encodeFunctionData({
    abi: accessControlAbi,
    args: [ADMIN_ROLE, account],
    functionName,
  }),
  label: `${name}.${functionName}(ADMIN_ROLE, ${accountLabel}=${account})`,
  to: deployment.core[name],
})

const transferOwnership = (
  to: `0x${string}`,
  name: string,
  newOwner: `0x${string}`
): Call => ({
  calldata: encodeFunctionData({
    abi: ownableAbi,
    args: [newOwner],
    functionName: "transferOwnership",
  }),
  label: `${name}.transferOwnership(testCouncil=${newOwner})`,
  to,
})

const ROLE_CONTRACTS = ["hub", "oracle", "executor", "genericMapping"]

// Every call on a chain is broadcast from the same wallet, so the calls take
// consecutive nonces starting at the wallet's current nonce on that chain.
const buildTransactions = async (
  rpc: string,
  from: `0x${string}`,
  calls: Call[]
) => {
  const client = createPublicClient({ transport: http(rpc) })
  const baseNonce = await client.getTransactionCount({ address: from })
  const maxFeePerGas = feeCap(await client.getGasPrice(), 2n)
  return Promise.all(
    calls.map(async (call, i) => {
      const gas = await client.estimateGas({
        account: from,
        data: call.calldata,
        to: call.to,
      })
      console.log(`  [${rpc} nonce ${baseNonce + i}] ${call.label}`)
      return {
        amount: "0",
        calldata: call.calldata,
        family: "ethereum-vm",
        from,
        gas: ((gas * 12n) / 10n).toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: "0",
        nonce: baseNonce + i,
        rpc,
        to: call.to,
      }
    })
  )
}

const main = async () => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(process.env.TEST_COUNCIL ?? "")) {
    throw new Error("Set TEST_COUNCIL to the test signer's derived EVM wallet")
  }
  const testCouncil = getAddress(process.env.TEST_COUNCIL!)

  const aurora = networks["1313161554"]
  const testSigner = aurora.contracts?.test?.multisigSigner
  if (!testSigner) throw new Error("No Aurora test multisigSigner configured")
  const derived = await deriveAllocatorSignerAddress(
    createPublicClient({ transport: http(aurora.rpc[0]) }),
    testSigner,
    "ethereum-vm"
  )
  if (!derived || getAddress(derived) !== testCouncil) {
    throw new Error(
      `TEST_COUNCIL ${testCouncil} does not match ${derived}, derived from test signer ${testSigner}`
    )
  }
  if (testCouncil === getAddress(DEV_COUNCIL)) {
    throw new Error("The test council must differ from the dev council")
  }

  // Refuse to emit calls the dev council could not execute.
  const arbitrumSepolia = createPublicClient({
    transport: http(ARBITRUM_SEPOLIA_RPC),
  })
  for (const name of ROLE_CONTRACTS) {
    const held = await arbitrumSepolia.readContract({
      abi: accessControlAbi,
      address: deployment.core[name],
      args: [ADMIN_ROLE, DEV_COUNCIL],
      functionName: "hasRole",
    })
    if (!held) throw new Error(`dev council lacks ${name}.ADMIN_ROLE`)
  }
  const ownerChecks: [string, string, `0x${string}`][] = [
    ["allocator", ARBITRUM_SEPOLIA_RPC, deployment.core.allocator],
    ...Object.entries(DEPOSITORY_RPCS).map(
      ([chain, rpc]) =>
        [`${chain} depository`, rpc, TESTNET_DEPOSITORY] as [
          string,
          string,
          `0x${string}`,
        ]
    ),
  ]
  for (const [label, rpc, address] of ownerChecks) {
    const owner = await createPublicClient({
      transport: http(rpc),
    }).readContract({ abi: ownableAbi, address, functionName: "owner" })
    if (getAddress(owner) !== getAddress(DEV_COUNCIL)) {
      throw new Error(`${label} owner is ${owner}, expected the dev council`)
    }
  }

  console.log(`dev council (signer): ${DEV_COUNCIL}`)
  console.log(`test council (new governor): ${testCouncil}\n`)

  const migration = [
    ...(await buildTransactions(ARBITRUM_SEPOLIA_RPC, DEV_COUNCIL, [
      ...ROLE_CONTRACTS.map((name) =>
        role("grantRole", name, testCouncil, "testCouncil")
      ),
      transferOwnership(deployment.core.allocator, "allocator", testCouncil),
      // Revoke last so the dev council keeps ADMIN_ROLE for every prior call.
      ...ROLE_CONTRACTS.map((name) =>
        role("revokeRole", name, DEV_COUNCIL, "devCouncil")
      ),
    ])),
    ...(
      await Promise.all(
        Object.entries(DEPOSITORY_RPCS).map(([chain, rpc]) =>
          buildTransactions(rpc, DEV_COUNCIL, [
            transferOwnership(
              TESTNET_DEPOSITORY,
              `${chain} depository`,
              testCouncil
            ),
          ])
        )
      )
    ).flat(),
  ]
  const migrationPath = getManifestPath(
    "migrate-test-ownership",
    "dev-to-test",
    "dev"
  )
  writeFileSync(migrationPath, `${stringifyJsonWithBigInt(migration)}\n`)
  console.log(`\n✅ Generated: ${migrationPath} (${migration.length} txs)\n`)

  // The accept call only simulates once the deployer has re-pointed the
  // pending transfer, so the gas limit is fixed rather than estimated.
  const oracleMultisig = deployment.core.oracleMultisig
  const acceptClient = createPublicClient({
    transport: http(ARBITRUM_SEPOLIA_RPC),
  })
  const accept = [
    {
      amount: "0",
      calldata: encodeFunctionData({
        abi: ownableAbi,
        functionName: "acceptOwnership",
      }),
      family: "ethereum-vm",
      from: testCouncil,
      gas: "60000",
      maxFeePerGas: feeCap(await acceptClient.getGasPrice(), 5n).toString(),
      maxPriorityFeePerGas: "0",
      nonce: await acceptClient.getTransactionCount({ address: testCouncil }),
      rpc: ARBITRUM_SEPOLIA_RPC,
      to: oracleMultisig,
    },
  ]
  const acceptPath = getManifestPath(
    "accept-oracle-multisig-ownership",
    "",
    "test"
  ).replace(/-\.json$/, ".json")
  mkdirSync(dirname(acceptPath), { recursive: true })
  writeFileSync(acceptPath, `${stringifyJsonWithBigInt(accept)}\n`)
  console.log(`✅ Generated: ${acceptPath}\n`)

  const pendingOwner = await acceptClient.readContract({
    abi: ownableAbi,
    address: oracleMultisig,
    functionName: "pendingOwner",
  })
  if (getAddress(pendingOwner) !== testCouncil) {
    console.log(
      `⚠️  oracleMultisig pendingOwner is ${pendingOwner}. Re-point it with the deployer (${DEPLOYER}) before executing ${acceptPath}:\n`
    )
    console.log(
      `   cast send ${oracleMultisig} "transferOwnership(address)" ${testCouncil} \\\n     --rpc-url ${ARBITRUM_SEPOLIA_RPC} --private-key "$DEPLOYER_PRIVATE_KEY"\n`
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
