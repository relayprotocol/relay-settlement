// ABOUTME generate a manifest wiring RelayOracleV2 + RelayAmountRateLimiter on the
// relay chain, to be submitted through RelayMultisigSigner. Covers the role/allowlist
// setup only (NOT the per-token bucket config, which is a separate step):
//   1. Hub                    grantRole(OPERATOR_ROLE, oracleV2)   -> V2 may mint/burn/transfer
//   2. RelayOracleV2          grantRole(ORACLE_ROLE, oracleMultisig)-> accept the oracle signer
//   3. IdempotencyStore       grantRole(WRITE_ROLE, oracleV2)      -> V2 may consume keys
//   4. RelayAmountRateLimiter grantRole(CONSUMER_ROLE, oracleV2)   -> V2 may consume budget
//   5. RelayOracleV2          addRateLimiter(amountRateLimiter)    -> allowlist the limiter
//   6. RelayAmountRateLimiter grantRole(ADMIN_ROLE, rateLimiterAdmin) [optional]
//      -> let a dedicated ops address set bucket configs
//
// Env:
//   ENV                deployment env to target (dev | stag | prod). Defaults to "prod".
//   IDEMPOTENCY_STORE  optional 0x idempotency store address. Defaults to
//                      deployment.oracleV2IdempotencyStore when present.
//   SIGNER             optional 0x signer address to use as `from`. When set, the
//                      NEAR/MPC derivation is skipped.
//   RATE_LIMITER_ADMIN optional 0x address to additionally grant ADMIN_ROLE on the
//                      rate limiter (so it can set bucket configs). Omitted when unset.
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
} from "viem"
import {
  relay as relayChain,
  aurora,
} from "@relay-protocol/settlement-networks"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"
import { RELAY_CHAIN_GAS_CONFIG } from "./helpers/chains"

const ENV = (process.env.ENV ?? "prod") as "dev" | "stag" | "prod"

// Deployment set for the target env (source of truth for the contract addresses).
const deployment = JSON.parse(
  readFileSync(
    join(
      __dirname,
      `../../../smart-contracts/deployments/contracts/${ENV}.json`
    ),
    "utf8"
  )
) as Record<string, string>

// Minimal inline ABIs (the published RelayOracleV2 ABI is not yet regenerated with
// addRateLimiter, so we avoid depending on it — same pattern as grant-role.ts).
const accessControlAbi = [
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    name: "grantRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

const oracleV2Abi = [
  {
    inputs: [{ name: "rateLimiter", type: "address" }],
    name: "addRateLimiter",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

const role = (name: string) => keccak256(toHex(name))

type Call = { label: string; to: `0x${string}`; calldata: `0x${string}` }

const buildCalls = (): Call[] => {
  const hub = deployment.hub as `0x${string}`
  const oracleV2 = deployment.oracleV2 as `0x${string}`
  const oracleMultisig = deployment.oracleMultisig as `0x${string}`
  const rateLimiter = deployment.amountRateLimiter as `0x${string}`
  const idempotencyStore = (process.env.IDEMPOTENCY_STORE ??
    deployment.oracleV2IdempotencyStore) as `0x${string}` | undefined
  if (idempotencyStore && !/^0x[0-9a-fA-F]{40}$/.test(idempotencyStore)) {
    throw new Error(
      `IDEMPOTENCY_STORE is not a valid address: ${idempotencyStore}`
    )
  }

  const calls: Call[] = [
    {
      calldata: encodeFunctionData({
        abi: accessControlAbi,
        args: [role("OPERATOR_ROLE"), oracleV2],
        functionName: "grantRole",
      }),
      label: `hub.grantRole(OPERATOR_ROLE, oracleV2=${oracleV2})`,
      to: hub,
    },
    {
      calldata: encodeFunctionData({
        abi: accessControlAbi,
        args: [role("ORACLE_ROLE"), oracleMultisig],
        functionName: "grantRole",
      }),
      label: `oracleV2.grantRole(ORACLE_ROLE, oracleMultisig=${oracleMultisig})`,
      to: oracleV2,
    },
    ...(idempotencyStore
      ? [
          {
            calldata: encodeFunctionData({
              abi: accessControlAbi,
              args: [role("WRITE_ROLE"), oracleV2],
              functionName: "grantRole",
            }),
            label: `idempotencyStore.grantRole(WRITE_ROLE, oracleV2=${oracleV2})`,
            to: idempotencyStore,
          },
        ]
      : []),
    {
      calldata: encodeFunctionData({
        abi: accessControlAbi,
        args: [role("CONSUMER_ROLE"), oracleV2],
        functionName: "grantRole",
      }),
      label: `amountRateLimiter.grantRole(CONSUMER_ROLE, oracleV2=${oracleV2})`,
      to: rateLimiter,
    },
    {
      calldata: encodeFunctionData({
        abi: oracleV2Abi,
        args: [rateLimiter],
        functionName: "addRateLimiter",
      }),
      label: `oracleV2.addRateLimiter(amountRateLimiter=${rateLimiter})`,
      to: oracleV2,
    },
  ]

  // Optional: grant ADMIN_ROLE on the rate limiter to a dedicated ops address so
  // it can set bucket configs.
  const rateLimiterAdmin = process.env.RATE_LIMITER_ADMIN as
    | `0x${string}`
    | undefined
  if (rateLimiterAdmin) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(rateLimiterAdmin)) {
      throw new Error(
        `RATE_LIMITER_ADMIN is not a valid address: ${rateLimiterAdmin}`
      )
    }
    calls.push({
      calldata: encodeFunctionData({
        abi: accessControlAbi,
        args: [role("ADMIN_ROLE"), rateLimiterAdmin],
        functionName: "grantRole",
      }),
      label: `amountRateLimiter.grantRole(ADMIN_ROLE, ${rateLimiterAdmin})`,
      to: rateLimiter,
    })
  }

  return calls
}

const main = async () => {
  let signerAddress = process.env.SIGNER as `0x${string}` | undefined
  if (signerAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(signerAddress)) {
      throw new Error(`SIGNER is not a valid address: ${signerAddress}`)
    }
  } else {
    const multisigSigner = (
      aurora.contracts as Record<string, { multisigSigner: string }>
    )[ENV]?.multisigSigner
    if (!multisigSigner) {
      throw new Error(`No aurora multisigSigner configured for env "${ENV}"`)
    }
    const auroraClient = createPublicClient({ transport: http(aurora.rpc[0]) })
    signerAddress = (await deriveAllocatorSignerAddress(
      auroraClient,
      multisigSigner,
      "ethereum-vm"
    )) as `0x${string}` | undefined
    if (!signerAddress) throw new Error("Failed to derive signer")
  }
  console.log(`env: ${ENV}`)
  console.log(`Using signer from MPC : ${signerAddress}`)

  const rpcUrl = relayChain.rpc[0]
  const relayChainClient = createPublicClient({ transport: http(rpcUrl) })

  const calls = buildCalls()

  // Fetch the base nonce once and assign sequentially: all calls are broadcast from the
  // same signer, so they must occupy consecutive nonces.
  const baseNonce = await relayChainClient.getTransactionCount({
    address: signerAddress,
  })

  const txs = await Promise.all(
    calls.map(async (call, i) => {
      const gas = await relayChainClient.estimateGas({
        account: signerAddress,
        data: call.calldata,
        to: call.to,
      })
      console.log(`  [nonce ${baseNonce + i}] ${call.label}`)
      return {
        amount: "0",
        calldata: call.calldata,
        family: "ethereum-vm",
        from: signerAddress,
        gas: ((gas * 110n) / 100n).toString(),
        maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas,
        maxPriorityFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas,
        nonce: baseNonce + i,
        rpc: rpcUrl,
        to: call.to,
      }
    })
  )

  const path = getManifestPath(
    "setup-oracle-v2-rate-limiter",
    `${ENV}-roles-and-allowlist`
  )
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch(console.error)
