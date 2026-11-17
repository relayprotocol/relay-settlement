// Generate only; never signs, submits or broadcasts.
// ENV=dev|stag|prod yarn workspace @relay-settlement/multisig-tools tsx \
//   scripts/generate-migrate-gateway-source.ts
// Production follows the existing 084 and 085 manifests, including 085's Arc tx.
import { readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem"
import {
  describeNonceConflicts,
  findNonceConflicts,
} from "../src/helpers/nonceConflicts"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"
import { getManifestPath, type ManifestEnv } from "./helpers/manifest"

export const migrationEnvironments = {
  dev: {
    depository: "0x06622432E1cf0A943c1bdE11Fa6464eE695870D7",
    previousBuilder: "0xC6A583365826fbDA61f9272CcB13750F193eedBa",
    signer: "0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7",
  },
  prod: {
    depository: "0x251e4b432D5C69D8f4d3D31Aae4aE4f3C4816fc7",
    previousBuilder: "0xAe649791F9c3076E17e7eDb6C1cd0372fC04c0f9",
    signer: "0xF61A305199fa1135d76FFaB3752D42F55cBd775A",
  },
  stag: {
    depository: "0x76fCEC815a8d6A6c12e0C67f46aA4cef257c7396",
    previousBuilder: "0x2dC06Cf79B882f50d64D794cC56b8d948CA2F832",
    signer: "0x71d8bE89D9f2339F0FE9cBA39496C6C9cbFF9da6",
  },
} as const

export const migrationAbi = parseAbi([
  "function owner() view returns (address)",
  "function allocator() view returns (address)",
  "function CONFIG() view returns (address)",
  "function depositsEnabled() view returns (bool)",
  "function setDepositsEnabled(bool)",
  "function payloadBuilders(string,bytes) view returns (address)",
  "function setPayloadBuilder(string,bytes,address)",
  "function getSourceTransferFeeKey(string) pure returns (bytes32)",
  "function setConfigValue(bytes32,bytes32)",
])

type Deployment = {
  core: { allocator: Address; config: Address }
  payloadBuilders: { gatewayVmPayloadBuilder: Address }
}

type Call = { to: Address; calldata: Hex; onPolygon: boolean; label: string }
type Transaction = {
  amount: string
  calldata: Hex
  family: "ethereum-vm"
  from: Address
  gas: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  nonce: number
  rpc: string
  to: Address
}

export function buildMigrationCalls(
  env: ManifestEnv,
  deployment: Deployment,
  arcFeeKey: Hex
): Call[] {
  const { depository } = migrationEnvironments[env]
  const { allocator, config } = deployment.core
  const builder = deployment.payloadBuilders.gatewayVmPayloadBuilder
  const registration = (chainId: string, address: Address): Call => ({
    calldata: encodeFunctionData({
      abi: migrationAbi,
      args: [chainId, depository, address],
      functionName: "setPayloadBuilder",
    }),
    label: `Set ${chainId} builder to ${address}`,
    onPolygon: false,
    to: allocator,
  })
  if (env === "dev") return [registration("polygon-gateway", builder)]

  return [
    {
      calldata: encodeFunctionData({
        abi: migrationAbi,
        args: [false],
        functionName: "setDepositsEnabled",
      }),
      label: "Disable Polygon Gateway deposits",
      onPolygon: true,
      to: depository,
    },
    {
      calldata: encodeFunctionData({
        abi: migrationAbi,
        args: [arcFeeKey, zeroHash],
        functionName: "setConfigValue",
      }),
      label: "Set arc-gateway source transfer fee to zero ppm",
      onPolygon: false,
      to: config,
    },
    registration("arc-gateway", builder),
    registration("polygon-gateway", zeroAddress),
  ]
}

// Reserve the still-pending production Hub nonces without modifying submitted
// manifests. Reject gaps rather than silently generating unexecutable nonces.
export function afterPrerequisites(current: number, nonces: number[]): number {
  const pending = nonces
    .filter((nonce) => nonce >= current)
    .sort((a, b) => a - b)
  for (const [index, nonce] of pending.entries()) {
    if (nonce !== current + index)
      throw new Error("Non-contiguous prerequisite nonces")
  }
  return current + pending.length
}

export async function generateMigration(env: ManifestEnv) {
  const deployment = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../contracts/relay-chain/deployments/contracts/${env}.json`
      ),
      "utf8"
    )
  ) as Deployment
  const { allocator, config } = deployment.core
  const builder = deployment.payloadBuilders.gatewayVmPayloadBuilder
  const { depository, previousBuilder, signer } = migrationEnvironments[env]
  const hubRpc =
    env === "dev"
      ? "https://rpc.testnet.relay.link"
      : "https://rpc.chain.relay.link"
  const polygonRpc = "https://polygon-bor-rpc.publicnode.com"
  const hub = createPublicClient({ transport: http(hubRpc) })
  if ((await hub.getChainId()) !== (env === "dev" ? 537724 : 537713)) {
    throw new Error("Wrong Hub chain")
  }
  for (const [address, functionName, expected] of [
    [allocator, "owner", signer],
    [config, "allocator", allocator],
    [builder, "CONFIG", config],
  ] as const) {
    const actual = await hub.readContract({
      abi: migrationAbi,
      address,
      functionName,
    })
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Unexpected ${functionName} on ${address}: ${actual}`)
    }
  }

  const currentNonce = await hub.getTransactionCount({
    address: signer,
    blockTag: "pending",
  })
  const prerequisites: Transaction[] =
    env === "prod"
      ? [
          "084-activate-gateway-gas-payer-prod.json",
          "085-configure-arc-gateway-source-prod.json",
        ].flatMap(
          (file) =>
            JSON.parse(
              readFileSync(
                join(__dirname, "../transactions/prod", file),
                "utf8"
              )
            ) as Transaction[]
        )
      : []
  let hubNonce = afterPrerequisites(
    currentNonce,
    prerequisites
      .filter(
        (tx) =>
          tx.rpc === hubRpc && tx.from.toLowerCase() === signer.toLowerCase()
      )
      .map((tx) => tx.nonce)
  )
  const pendingHubSetup = hubNonce > currentNonce
  if (pendingHubSetup)
    console.log(
      `[${env}] Execute production 084 and 085 before this migration; Hub starts at nonce ${hubNonce}`
    )

  const registered = async (chainId: string) =>
    hub.readContract({
      abi: migrationAbi,
      address: allocator,
      args: [chainId, depository],
      functionName: "payloadBuilders",
    })
  const polygonBuilder = await registered("polygon-gateway")
  const expectedPolygonBuilders: string[] = [previousBuilder, builder]
  if (env !== "dev") expectedPolygonBuilders.push(zeroAddress)
  if (env === "prod" && pendingHubSetup)
    expectedPolygonBuilders.push("0xb7781ab1533Aff2E8Ae1bBdFa2ac8979DCf37356")
  if (
    !expectedPolygonBuilders.some(
      (value) => value.toLowerCase() === polygonBuilder.toLowerCase()
    )
  ) {
    throw new Error(`Unexpected polygon-gateway builder: ${polygonBuilder}`)
  }

  let polygonNonce = 0
  let polygonFees = RELAY_CHAIN_GAS_CONFIG as {
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }
  const polygon = createPublicClient({ transport: http(polygonRpc) })
  const arcFeeKey = await hub.readContract({
    abi: migrationAbi,
    address: builder,
    args: ["arc-gateway"],
    functionName: "getSourceTransferFeeKey",
  })
  if (env !== "dev") {
    const arcRpc = "https://rpc.mainnet.arc.io"
    const arc = createPublicClient({ transport: http(arcRpc) })
    if (
      (await polygon.getChainId()) !== 137 ||
      (await arc.getChainId()) !== 5042
    ) {
      throw new Error("Wrong Gateway chain")
    }
    for (const client of [polygon, arc]) {
      const owner = await client.readContract({
        abi: migrationAbi,
        address: depository,
        functionName: "owner",
      })
      if (owner.toLowerCase() !== signer.toLowerCase())
        throw new Error("Unexpected depository owner")
    }
    const arcBuilder = await registered("arc-gateway")
    const expectedArcBuilders: string[] = [previousBuilder, builder]
    if (pendingHubSetup) expectedArcBuilders.push(zeroAddress)
    if (
      !expectedArcBuilders.some(
        (value) => value.toLowerCase() === arcBuilder.toLowerCase()
      )
    ) {
      throw new Error(`Unexpected arc-gateway builder: ${arcBuilder}`)
    }
    const arcEnabled = await arc.readContract({
      abi: migrationAbi,
      address: depository,
      functionName: "depositsEnabled",
    })
    if (!arcEnabled) {
      const arcNonce = await arc.getTransactionCount({
        address: signer,
        blockTag: "pending",
      })
      const queuedActivation = prerequisites.some((tx) => {
        if (
          tx.rpc !== arcRpc ||
          tx.nonce < arcNonce ||
          tx.to.toLowerCase() !== depository.toLowerCase()
        )
          return false
        const call = decodeFunctionData({
          abi: migrationAbi,
          data: tx.calldata,
        })
        return (
          call.functionName === "setDepositsEnabled" && call.args[0] === true
        )
      })
      if (!queuedActivation)
        throw new Error(
          "Arc deposits are disabled without a pending activation"
        )
      console.log(
        `[${env}] Arc deposits require the Arc transaction in production 085 first`
      )
    }
    polygonNonce = await polygon.getTransactionCount({
      address: signer,
      blockTag: "pending",
    })
    const fees = await polygon.estimateFeesPerGas()
    polygonFees = {
      maxFeePerGas: fees.maxFeePerGas * 2n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    }
  }

  const transactions: Transaction[] = []
  for (const call of buildMigrationCalls(env, deployment, arcFeeKey)) {
    const client = call.onPolygon ? polygon : hub
    const gas = await client.estimateGas({
      account: signer,
      data: call.calldata,
      to: call.to,
    })
    const fees = call.onPolygon ? polygonFees : RELAY_CHAIN_GAS_CONFIG
    const nonce = call.onPolygon ? polygonNonce++ : hubNonce++
    transactions.push({
      amount: "0",
      calldata: call.calldata,
      family: "ethereum-vm",
      from: signer,
      gas: ((gas * 120n + 99n) / 100n).toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      nonce,
      rpc: call.onPolygon ? polygonRpc : hubRpc,
      to: call.to,
    })
    console.log(
      `[${env} ${call.onPolygon ? "Polygon" : "Hub"} nonce ${nonce}] ${call.label}`
    )
  }
  return transactions
}

async function main() {
  const env = process.env.ENV
  if (env !== "dev" && env !== "stag" && env !== "prod")
    throw new Error("ENV must be dev, stag or prod")
  const transactions = await generateMigration(env)
  const path = getManifestPath("migrate-gateway-source", env, env)
  writeFileSync(path, `${JSON.stringify(transactions, null, 2)}\n`)
  const conflicts = await findNonceConflicts(path)
  if (conflicts.length) {
    unlinkSync(path)
    throw new Error(`Nonce conflicts:\n${describeNonceConflicts(conflicts)}`)
  }
  console.log(`Generated ${path}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
