// ABOUTME: generates a manifest granting DEPOSITORY_ROLE on destination-chain
// ABOUTME: MulticallRouters to each chain's depository, signed by the env council.
//
// Routers whose constructor admin is the council MPC wallet (stag/prod) cannot be
// wired by a deployer key: the grant must come from the council itself, as a
// destination-chain transaction. One tx per chain; chains where the depository
// already holds the role are skipped, so re-runs are safe.
//
// Router per chain comes from `multicallRouters` in contracts/<ENV>.json, depository per
// chain from settlement-networks (it differs within one env) -- nothing from the command line.
//
// Env:
//   ENV              dev | stag | prod. Defaults to "prod". Selects the records file
//                    and the multisig signer used to derive the council wallet.
//   CHAINS           optional comma-separated destination chain slugs. Defaults to
//                    every slug under `multicallRouters` in the records file. Per-chain
//                    RPCs follow settlement-networks (`RPC_<chainId>` overrides them).
//   FEE_MULTIPLIER   optional headroom on the estimated fee (default 1). Manifests are
//                    signed hours before execution, so busy chains (ethereum) need 2-3.
//   PRIORITY_FEE_FLOOR_GWEI  optional minimum tip (default 0.01). viem estimates a ~0 tip
//                    on quiet chains and builders then skip the tx for hours.
//   NONCE_OFFSETS    optional per-chain nonce offsets, `slug=n,slug=n`, for destination-
//                    chain transactions queued in earlier manifests but not yet mined.
//   SIGNER           optional 0x signer address to use as `from`. When set, the
//                    NEAR/MPC derivation is skipped.
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseGwei,
  stringToBytes,
} from "viem"
import { aurora, networks } from "@relay-protocol/settlement-networks"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

const ENV = (process.env.ENV ?? "prod") as "dev" | "stag" | "prod"

const accessControlAbi = parseAbi([
  "function grantRole(bytes32 role, address account)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
])

const DEPOSITORY_ROLE = keccak256(stringToBytes("DEPOSITORY_ROLE"))

const FEE_MULTIPLIER = Number(process.env.FEE_MULTIPLIER ?? "1")
if (!(FEE_MULTIPLIER >= 1)) {
  throw new Error(
    `FEE_MULTIPLIER must be >= 1 (got ${process.env.FEE_MULTIPLIER})`
  )
}
// Scales a wei amount by FEE_MULTIPLIER without float precision loss on big values.
const withHeadroom = (fee: bigint) =>
  (fee * BigInt(Math.round(FEE_MULTIPLIER * 100))) / 100n

const PRIORITY_FEE_FLOOR = parseGwei(
  process.env.PRIORITY_FEE_FLOOR_GWEI ?? "0.01"
)

const NONCE_OFFSETS = Object.fromEntries(
  (process.env.NONCE_OFFSETS ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [slug, offset] = entry.split("=")
      if (!slug || !/^\d+$/.test(offset ?? "")) {
        throw new Error(`NONCE_OFFSETS entry must be slug=n (got "${entry}")`)
      }
      return [slug, Number(offset)]
    })
)

type Address = `0x${string}`

const deploymentFile = JSON.parse(
  readFileSync(
    join(
      __dirname,
      `../../../smart-contracts/deployments/contracts/${ENV}.json`
    ),
    "utf8"
  )
) as { multicallRouters?: Record<string, string> }

const buildGrant = async (slug: string, signerAddress: Address) => {
  const net = networks[slug]
  if (!net) throw new Error("not in settlement-networks")
  const depository = net.contracts?.[ENV]?.depository
  if (!depository || !isAddress(depository)) {
    throw new Error(`no ${ENV} depository in settlement-networks`)
  }
  const router = deploymentFile.multicallRouters?.[slug]
  if (!router || !isAddress(router)) {
    throw new Error(
      `multicallRouters.${slug} missing from contracts/${ENV}.json`
    )
  }
  const rpc = net.rpc[0]
  if (!rpc)
    throw new Error(`no rpc in settlement-networks (set RPC_${net.chainId})`)
  const chain = { chainId: net.chainId, depository, router, rpc, slug }
  const client = createPublicClient({ transport: http(rpc) })

  // reads against the wrong chain silently return empty values
  const liveChainId = await client.getChainId()
  if (BigInt(liveChainId) !== chain.chainId) {
    throw new Error(
      `RPC ${chain.rpc} serves chain ${liveChainId}, expected ${chain.chainId}`
    )
  }
  const code = await client.getCode({ address: chain.router })
  if (!code || code === "0x") {
    throw new Error(`router ${chain.router} has no code -- deploy it first`)
  }
  const granted = (await client.readContract({
    abi: accessControlAbi,
    address: chain.router,
    args: [DEPOSITORY_ROLE, chain.depository],
    functionName: "hasRole",
  })) as boolean
  if (granted) {
    console.log(
      `  [skip] ${chain.slug} depository ${chain.depository} already holds DEPOSITORY_ROLE`
    )
    return undefined
  }

  const calldata = encodeFunctionData({
    abi: accessControlAbi,
    args: [DEPOSITORY_ROLE, chain.depository],
    functionName: "grantRole",
  })
  // Legacy-only chains (e.g. metis) must be priced with gasPrice; the executor
  // picks the tx type from which fee fields are present, so emit only one kind.
  const fees = client
    .estimateFeesPerGas()
    .then(({ maxFeePerGas, maxPriorityFeePerGas }) => {
      const tip =
        maxPriorityFeePerGas < PRIORITY_FEE_FLOOR
          ? PRIORITY_FEE_FLOOR
          : maxPriorityFeePerGas
      // the raised tip must still fit under the cap
      return {
        maxFeePerGas: (
          withHeadroom(maxFeePerGas) +
          (tip - maxPriorityFeePerGas)
        ).toString(),
        maxPriorityFeePerGas: tip.toString(),
      }
    })
    .catch(async (error) => {
      if (
        (error as { name?: string }).name?.includes(
          "Eip1559FeesNotSupportedError"
        )
      ) {
        return {
          gasPrice: withHeadroom(await client.getGasPrice()).toString(),
        }
      }
      throw error
    })
  const [nonce, feeFields, gasEstimate] = await Promise.all([
    client
      .getTransactionCount({ address: signerAddress })
      .then((count) => count + (NONCE_OFFSETS[slug] ?? 0)),
    fees,
    client.estimateGas({
      account: signerAddress,
      data: calldata,
      to: chain.router,
    }),
  ])
  console.log(
    `  [nonce ${nonce}] ${chain.slug} router ${chain.router}.grantRole(DEPOSITORY_ROLE, ${chain.depository})`
  )
  return {
    amount: "0",
    calldata,
    family: "ethereum-vm",
    from: signerAddress,
    gas: ((gasEstimate * 110n) / 100n).toString(),
    nonce,
    rpc: chain.rpc,
    to: chain.router,
    ...feeFields,
  }
}

const main = async () => {
  if (ENV !== "dev" && ENV !== "stag" && ENV !== "prod") {
    throw new Error(`ENV must be dev, stag or prod (got "${ENV}")`)
  }
  const slugs = process.env.CHAINS
    ? process.env.CHAINS.split(",").filter(Boolean)
    : Object.keys(deploymentFile.multicallRouters ?? {})
  if (slugs.length === 0) {
    throw new Error(
      `no chains: contracts/${ENV}.json has no multicallRouters and CHAINS is unset`
    )
  }

  let signerAddress = process.env.SIGNER as Address | undefined
  if (signerAddress) {
    if (!isAddress(signerAddress)) {
      throw new Error(`SIGNER is not a valid address: ${signerAddress}`)
    }
  } else {
    const multisigSigner = aurora.contracts?.[ENV]?.multisigSigner
    if (!multisigSigner) {
      throw new Error(`No aurora multisigSigner configured for env "${ENV}"`)
    }
    const auroraClient = createPublicClient({ transport: http(aurora.rpc[0]) })
    signerAddress = (await deriveAllocatorSignerAddress(
      auroraClient,
      multisigSigner,
      "ethereum-vm"
    )) as Address | undefined
    if (!signerAddress) throw new Error("Failed to derive signer")
  }
  console.log(`env: ${ENV}`)
  console.log(`Using signer from MPC : ${signerAddress}`)

  const txs = []
  for (const slug of slugs) {
    // one flaky public RPC out of ~50 must at least say which chain it was
    const tx = await buildGrant(slug, signerAddress).catch((error) => {
      throw new Error(`${slug}: ${(error as Error).message}`)
    })
    if (tx) txs.push(tx)
  }

  if (txs.length === 0) {
    console.log("Nothing to do -- every chain already granted")
    return
  }

  const path = getManifestPath("grant-router-depository-role", ENV, ENV)
  writeFileSync(path, stringifyJsonWithBigInt(txs))
  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
