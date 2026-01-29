// ABOUTME parse a manifest file for AccessControl grantRole/revokeRole operations to
// be submitted through RelayMultisgSigner
import { writeFileSync } from "fs"
import { encodeFunctionData, keccak256 } from "viem"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import {
  getSignerAddress,
  createRelayChainClient,
  RELAY_CHAIN_GAS_CONFIG,
} from "./helpers/chains"

type RoleCallArgs = {
  method: "grantRole" | "revokeRole"
  contract: string
  role: string // Role name (e.g., "ADMIN_ROLE") or bytes32 (0x...)
  account: string
}

const calls: RoleCallArgs[] = [
  // {
  //   method: "grantRole",
  //   contract: "0x...",
  //   role: "ADMIN_ROLE",
  //   account: "0x...",
  // },
]

const AccessControlABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "role", type: "bytes32" },
      { internalType: "address", name: "account", type: "address" },
    ],
    name: "grantRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "role", type: "bytes32" },
      { internalType: "address", name: "account", type: "address" },
    ],
    name: "revokeRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

const getOperationName = ({
  method,
  contract,
  role,
  account,
}: RoleCallArgs) => {
  const contractShort = contract.slice(0, 8)
  const accountShort = account.slice(0, 8)
  const roleShort = role.startsWith("0x") ? role.slice(0, 10) : role
  return `${method}-${contractShort}-${roleShort}-${accountShort}`
}

const toRoleBytes32 = (role: string): `0x${string}` =>
  role.startsWith("0x") && role.length === 66
    ? (role as `0x${string}`)
    : keccak256(role as `0x${string}`)

const main = async () => {
  const signerAddress = await getSignerAddress()
  console.log(`Using signer from MPC : ${signerAddress}`)

  const operationNames = calls
    .map(getOperationName)
    .join("_")
    .replace(/ /g, "-")
  console.log(`Operation names: ${operationNames}`)

  const { client: relayChainClient, rpcUrl } = createRelayChainClient()
  const txs = await Promise.all(
    calls.map(async ({ method, role, account, contract }) => {
      const calldata = encodeFunctionData({
        abi: AccessControlABI,
        args: [toRoleBytes32(role), account as `0x${string}`],
        functionName: method,
      })

      const [nonce, gas] = await Promise.all([
        relayChainClient.getTransactionCount({
          address: signerAddress as `0x${string}`,
        }),
        relayChainClient.estimateGas({
          account: signerAddress as `0x${string}`,
          data: calldata,
          to: contract as `0x${string}`,
        }),
      ])

      return {
        amount: "0",
        calldata,
        family: "ethereum-vm",
        from: signerAddress,
        gas: ((gas * 110n) / 100n).toString(),
        maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
        maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
        nonce,
        rpc: rpcUrl,
        to: contract as `0x${string}`,
      }
    })
  )

  const path = getManifestPath("access-control", operationNames)
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`✅ Generated: ${path}`)
  console.log(`\n📝 Generated ${txs.length} transaction(s)`)
}

main().catch(console.error)
