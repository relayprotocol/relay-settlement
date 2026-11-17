#!/usr/bin/env ts-node
/**
 * Independently verify a noncanonical Safe core deployment and optionally save
 * its addresses under `safe` in the chain's contracts JSON file.
 *
 * Required env:
 *   RPC_URL
 *
 * Optional env:
 *   SAFE_DEPLOYMENTS_DIR          Deployment metadata produced during deploy
 *   HUB_CONTRACTS_PATH            Defaults to the file matching the RPC chain
 *   WRITE_SAFE_CORE_DEPLOYMENT=1  Update the contracts file
 */

import {
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  type Address,
} from "viem"
import {
  defaultHubContractsPath,
  readHardhatDeployments,
  readSafeCoreDeployment,
  requireEnv,
  REQUIRED_SAFE_CORE_CONTRACTS,
  SAFE_SMART_ACCOUNT_VERSION,
  writeSafeCoreDeployment,
} from "./safe-core-common"

const versionAbi = parseAbi(["function VERSION() view returns (string)"])
const proxyFactoryAbi = parseAbi([
  "function proxyCreationCode() pure returns (bytes)",
])

type DeploymentInput = {
  address: Address
}

async function main() {
  const rpcUrl = requireEnv("RPC_URL")
  const client = createPublicClient({ transport: http(rpcUrl) })
  const chainId = await client.getChainId()
  const blockNumber = await client.getBlockNumber()
  const hubContractsPath =
    process.env.HUB_CONTRACTS_PATH ?? defaultHubContractsPath(chainId)

  const deploymentsDirectory = process.env.SAFE_DEPLOYMENTS_DIR
  const inputs: Record<string, DeploymentInput> = deploymentsDirectory
    ? readHardhatDeployments(deploymentsDirectory)
    : readSafeCoreDeployment(hubContractsPath).contracts

  console.log(`Verifying noncanonical Safe core v${SAFE_SMART_ACCOUNT_VERSION}`)
  console.log(`  chainId: ${chainId}`)
  console.log(`  block:   ${blockNumber}`)

  const contracts: Record<string, { address: Address }> = {}
  for (const name of REQUIRED_SAFE_CORE_CONTRACTS) {
    const input = inputs[name]
    const code = await client.getCode({ address: input.address })
    if (!code || code === "0x") {
      throw new Error(`${name} has no code at ${input.address}`)
    }
    contracts[name] = { address: input.address }
    console.log(`  ${name}: ${input.address} (${keccak256(code)})`)
  }

  for (const name of ["Safe", "SafeL2"] as const) {
    const version = await client.readContract({
      abi: versionAbi,
      address: contracts[name].address,
      functionName: "VERSION",
    })
    if (version !== SAFE_SMART_ACCOUNT_VERSION) {
      throw new Error(
        `${name}.VERSION() returned ${version}; expected ${SAFE_SMART_ACCOUNT_VERSION}`
      )
    }
  }

  const proxyCreationCode = await client.readContract({
    abi: proxyFactoryAbi,
    address: contracts.SafeProxyFactory.address,
    functionName: "proxyCreationCode",
  })
  if (proxyCreationCode === "0x") {
    throw new Error("SafeProxyFactory.proxyCreationCode() returned empty bytes")
  }

  if (process.env.WRITE_SAFE_CORE_DEPLOYMENT === "1") {
    writeSafeCoreDeployment(hubContractsPath, chainId, contracts)
    console.log(`Safe addresses written to ${hubContractsPath}`)
  }

  console.log("Safe core deployment verified")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
