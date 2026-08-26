#!/usr/bin/env ts-node
/**
 * Deploy an idempotent 1-of-1 Safe through the verified SafeProxyFactory and
 * confirm its singleton, owner, and threshold.
 *
 * Required env:
 *   RPC_URL
 *   SAFE_SMOKE_TEST_SALT_NONCE
 *   PK, DEPLOYER_PRIVATE_KEY, or MNEMONIC
 *
 * Optional env:
 *   HUB_CONTRACTS_PATH       Defaults to the file matching the RPC chain
 *   SAFE_SMOKE_TEST_DRY_RUN=1 Predict the address without broadcasting
 *   SAFE_SMOKE_TEST_OWNER    Defaults to the deployment account
 *   SAFE_SMOKE_TEST_SINGLETON=Safe|SafeL2 (default SafeL2)
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  getCreate2Address,
  http,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import {
  asAddress,
  defaultHubContractsPath,
  readSafeCoreDeployment,
  requireEnv,
} from "./safe-core-common"

const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
])
const proxyAbi = parseAbi(["function masterCopy() view returns (address)"])
const proxyFactoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() pure returns (bytes)",
])

function deploymentAccount() {
  const privateKey = process.env.PK ?? process.env.DEPLOYER_PRIVATE_KEY
  if (privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("PK/DEPLOYER_PRIVATE_KEY must be a 32-byte hex value")
    }
    return privateKeyToAccount(privateKey as Hex)
  }
  if (process.env.MNEMONIC) {
    return mnemonicToAccount(process.env.MNEMONIC)
  }
  throw new Error("set PK, DEPLOYER_PRIVATE_KEY, or MNEMONIC")
}

function parseSaltNonce(): bigint {
  const value = requireEnv("SAFE_SMOKE_TEST_SALT_NONCE")
  if (!/^\d+$/.test(value)) {
    throw new Error("SAFE_SMOKE_TEST_SALT_NONCE must be a decimal integer")
  }
  return BigInt(value)
}

async function main() {
  const rpcUrl = requireEnv("RPC_URL")
  const account = deploymentAccount()
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) })
  const chainId = await publicClient.getChainId()
  const deployment = readSafeCoreDeployment(
    process.env.HUB_CONTRACTS_PATH ?? defaultHubContractsPath(chainId)
  )
  if (deployment.chainId !== chainId.toString()) {
    throw new Error("Hub contracts file does not match the RPC chain")
  }

  const singletonName = process.env.SAFE_SMOKE_TEST_SINGLETON ?? "SafeL2"
  if (singletonName !== "Safe" && singletonName !== "SafeL2") {
    throw new Error("SAFE_SMOKE_TEST_SINGLETON must be Safe or SafeL2")
  }
  const singleton = deployment.contracts[singletonName].address
  const factory = deployment.contracts.SafeProxyFactory.address
  const fallbackHandler =
    deployment.contracts.CompatibilityFallbackHandler.address
  const owner = process.env.SAFE_SMOKE_TEST_OWNER
    ? asAddress(process.env.SAFE_SMOKE_TEST_OWNER, "SAFE_SMOKE_TEST_OWNER")
    : account.address
  const saltNonce = parseSaltNonce()

  const initializer = encodeFunctionData({
    abi: safeAbi,
    args: [
      [owner],
      1n,
      zeroAddress,
      "0x",
      fallbackHandler,
      zeroAddress,
      0n,
      zeroAddress,
    ],
    functionName: "setup",
  })
  const proxyCreationCode = await publicClient.readContract({
    abi: proxyFactoryAbi,
    address: factory,
    functionName: "proxyCreationCode",
  })
  const deploymentData = encodePacked(
    ["bytes", "uint256"],
    [proxyCreationCode, BigInt(singleton)]
  )
  const salt = keccak256(
    encodePacked(["bytes32", "uint256"], [keccak256(initializer), saltNonce])
  )
  const safeAddress = getCreate2Address({
    bytecode: deploymentData,
    from: factory,
    salt,
  })

  const existingCode = await publicClient.getCode({ address: safeAddress })
  if (!existingCode || existingCode === "0x") {
    if (process.env.SAFE_SMOKE_TEST_DRY_RUN === "1") {
      console.log("Safe deployment smoke-test dry run passed")
      console.log(`  predicted Safe: ${safeAddress}`)
      return
    }
    const hash = await walletClient.writeContract({
      abi: proxyFactoryAbi,
      address: factory,
      args: [singleton, initializer, saltNonce],
      chain: null,
      functionName: "createProxyWithNonce",
    })
    console.log(`Safe deployment transaction: ${hash}`)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") {
      throw new Error("Safe smoke-test deployment reverted")
    }
  } else {
    console.log(`Safe already deployed at ${safeAddress}`)
  }

  const [masterCopy, owners, threshold] = await Promise.all([
    publicClient.readContract({
      abi: proxyAbi,
      address: safeAddress,
      functionName: "masterCopy",
    }),
    publicClient.readContract({
      abi: safeAbi,
      address: safeAddress,
      functionName: "getOwners",
    }),
    publicClient.readContract({
      abi: safeAbi,
      address: safeAddress,
      functionName: "getThreshold",
    }),
  ])
  if (masterCopy.toLowerCase() !== singleton.toLowerCase()) {
    throw new Error("smoke-test Safe points to the wrong singleton")
  }
  if (threshold !== 1n || owners.length !== 1) {
    throw new Error("smoke-test Safe has unexpected owner configuration")
  }
  if (owners[0].toLowerCase() !== owner.toLowerCase()) {
    throw new Error("smoke-test Safe owner does not match")
  }

  console.log("Safe deployment smoke test passed")
  console.log(`  safe:      ${safeAddress}`)
  console.log(`  singleton: ${singleton}`)
  console.log(`  owner:     ${owner as Address}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
