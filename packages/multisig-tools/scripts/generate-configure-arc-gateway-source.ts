// Generate only; never signs, submits or broadcasts.
// ENV=stag|prod [RELAY_NONCE_OFFSET=4] yarn workspace \
//   @relay-settlement/multisig-tools tsx scripts/generate-configure-arc-gateway-source.ts
import { readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { networks } from "@relay-protocol/settlement-networks"
import {
  createPublicClient,
  encodeFunctionData,
  http,
  pad,
  parseAbi,
  parseUnits,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import { GATEWAY_CHAINS } from "../../../contracts/relay-chain/deployments/configs/gateway-vm"
import {
  describeNonceConflicts,
  findNonceConflicts,
} from "../src/helpers/nonceConflicts"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"
import { getManifestPath } from "./helpers/manifest"

const environments = {
  prod: {
    depository: "0x251e4b432D5C69D8f4d3D31Aae4aE4f3C4816fc7",
    signer: "0xF61A305199fa1135d76FFaB3752D42F55cBd775A",
  },
  stag: {
    depository: "0x76fCEC815a8d6A6c12e0C67f46aA4cef257c7396",
    signer: "0x71d8bE89D9f2339F0FE9cBA39496C6C9cbFF9da6",
  },
} as const

const abi = parseAbi([
  "function owner() view returns (address)",
  "function allocator() view returns (address)",
  "function USDC() view returns (address)",
  "function CONFIG() view returns (address)",
  "function depositsEnabled() view returns (bool)",
  "function setDepositsEnabled(bool)",
  "function payloadBuilders(string,bytes) view returns (address)",
  "function setPayloadBuilder(string,bytes,address)",
  "function getCircleDomainKey(string) pure returns (bytes32)",
  "function getDomainTokenKey(string) pure returns (bytes32)",
  "function getGasFeeKey(string) pure returns (bytes32)",
  "function getAllocatorAllowedKey(string,address) pure returns (bytes32)",
  "function getConfigValue(bytes32) view returns (bytes32)",
  "function setConfigValues(bytes32[],bytes32[])",
])

const main = async () => {
  const env = process.env.ENV
  if (env !== "stag" && env !== "prod") {
    throw new Error("ENV must be stag or prod")
  }
  const offset = Number(process.env.RELAY_NONCE_OFFSET ?? "0")
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Invalid RELAY_NONCE_OFFSET")
  }
  const { core, payloadBuilders } = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../contracts/relay-chain/deployments/contracts/${env}.json`
      ),
      "utf8"
    )
  ) as {
    core: Record<string, Address>
    payloadBuilders: Record<string, Address>
  }
  const { config, allocator } = core
  const builder = payloadBuilders.gatewayVmPayloadBuilder
  const { depository, signer } = environments[env]
  const arc = GATEWAY_CHAINS.find((chain) => chain.name === "arc")!
  const chainId = `${arc.chainId}-gateway`
  // Public endpoints keep generated manifests suitable for this public repo.
  const hubRpc = "https://rpc.chain.relay.link"
  const arcRpc = "https://rpc.mainnet.arc.io"
  const hub = createPublicClient({ transport: http(hubRpc) })
  const arcClient = createPublicClient({ transport: http(arcRpc) })
  if ((await hub.getChainId()) !== 537713) throw new Error("Wrong Hub chain")
  if (BigInt(await arcClient.getChainId()) !== networks.arc.chainId) {
    throw new Error("Wrong Arc chain")
  }
  for (const [address, functionName, expected] of [
    [allocator, "owner", signer],
    [config, "allocator", allocator],
    [builder, "CONFIG", config],
  ] as const) {
    const actual = await hub.readContract({ abi, address, functionName })
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Unexpected ${functionName} on ${address}: ${actual}`)
    }
  }
  const gatewayAllocator = await createPublicClient({
    transport: http(networks.polygon.rpc[0]),
  }).readContract({ abi, address: depository, functionName: "allocator" })
  if (gatewayAllocator === zeroAddress)
    throw new Error("Gateway allocator is unset")
  for (const [functionName, expected] of [
    ["owner", signer],
    ["USDC", arc.usdc],
    ["allocator", gatewayAllocator],
  ] as const) {
    const actual = await arcClient.readContract({
      abi,
      address: depository,
      functionName,
    })
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Unexpected Arc ${functionName}: ${actual}`)
    }
  }
  const keys = await Promise.all(
    (["getCircleDomainKey", "getDomainTokenKey", "getGasFeeKey"] as const).map(
      (functionName) =>
        hub.readContract({
          abi,
          address: builder,
          args: [chainId],
          functionName,
        })
    )
  )
  // The allocator allowlist is scoped per Gateway source chain
  keys.push(
    await hub.readContract({
      abi,
      address: builder,
      args: [chainId, gatewayAllocator],
      functionName: "getAllocatorAllowedKey",
    })
  )
  const calls: { calldata: Hex; to: Address; onArc: boolean }[] = [
    {
      calldata: encodeFunctionData({
        abi,
        args: [
          keys,
          [
            toHex(arc.domain, { size: 32 }),
            pad(arc.usdc, { size: 32 }),
            toHex(parseUnits(arc.gasFeeUsdc, 6), { size: 32 }),
            toHex(1, { size: 32 }),
          ],
        ],
        functionName: "setConfigValues",
      }),
      onArc: false,
      to: config,
    },
  ]
  const registered = await hub.readContract({
    abi,
    address: allocator,
    args: [chainId, depository],
    functionName: "payloadBuilders",
  })
  if (registered.toLowerCase() !== builder.toLowerCase()) {
    if (registered !== zeroAddress)
      throw new Error(`Unexpected source builder: ${registered}`)
    calls.push({
      calldata: encodeFunctionData({
        abi,
        args: [chainId, depository, builder],
        functionName: "setPayloadBuilder",
      }),
      onArc: false,
      to: allocator,
    })
  }
  if (
    !(await arcClient.readContract({
      abi,
      address: depository,
      functionName: "depositsEnabled",
    }))
  ) {
    calls.push({
      calldata: encodeFunctionData({
        abi,
        args: [true],
        functionName: "setDepositsEnabled",
      }),
      onArc: true,
      to: depository,
    })
  }
  let hubNonce =
    (await hub.getTransactionCount({ address: signer, blockTag: "pending" })) +
    offset
  let arcNonce = await arcClient.getTransactionCount({
    address: signer,
    blockTag: "pending",
  })
  const arcFees = await arcClient.estimateFeesPerGas()
  const transactions = []
  for (const call of calls) {
    const client = call.onArc ? arcClient : hub
    const gas = await client.estimateGas({
      account: signer,
      data: call.calldata,
      to: call.to,
    })
    const fees = call.onArc
      ? {
          maxFeePerGas: arcFees.maxFeePerGas * 2n,
          maxPriorityFeePerGas: arcFees.maxPriorityFeePerGas,
        }
      : RELAY_CHAIN_GAS_CONFIG
    transactions.push({
      amount: "0",
      calldata: call.calldata,
      family: "ethereum-vm",
      from: signer,
      gas: ((gas * 120n + 99n) / 100n).toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      nonce: call.onArc ? arcNonce++ : hubNonce++,
      rpc: call.onArc ? arcRpc : hubRpc,
      to: call.to,
    })
  }
  const path = getManifestPath("configure-arc-gateway-source", env, env)
  writeFileSync(path, `${JSON.stringify(transactions, null, 2)}\n`)
  const conflicts = await findNonceConflicts(path)
  if (conflicts.length) {
    unlinkSync(path)
    throw new Error(`Nonce conflicts:\n${describeNonceConflicts(conflicts)}`)
  }
  console.log(`Generated ${path}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
