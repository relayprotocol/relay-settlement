import networks from "@relay-protocol/settlement-networks"
import { task } from "hardhat/config"
import {
  concat,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  toBytes,
} from "viem"
import { getViemClients } from "../../lib/viem"

// Use a deterministic salt for deploys
const SALT = keccak256(toBytes("relay_deposit_address_factory"))

// Deterministic deployment proxy (same on all chains)
// https://github.com/Arachnid/deterministic-deployment-proxy
const DETERMINISTIC_DEPLOYER_ADDRESS =
  "0x4e59b44847b379578588920cA78FbF26c0B4956C"

// Fallback gas limits when estimation fails. Tried in order:
// factory deploy needs ~600k; 5M fits chains with tight block caps (e.g.
// Scroll at 20M), 30M covers typical L1/L2 blocks, 500M covers chains with
// inflated gas accounting (e.g. Mantle).
const FALLBACK_GAS_LIMITS = [5_000_000n, 30_000_000n, 500_000_000n]

// How long to wait for a deployed contract's code to appear on the RPC.
const VERIFY_CODE_RETRIES = 10
const VERIFY_CODE_DELAY_MS = 2000

const isGasError = (msg: string) =>
  msg.includes("gas") || msg.includes("Gas") || msg.includes("intrinsic")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

task(
  "deploy:depositAddressFactory",
  "Deploy the DepositAddressFactory contract using deterministic deployer proxy"
)
  .addOptionalParam(
    "env",
    "The environment to deploy for (stag or prod)",
    "prod"
  )
  .addOptionalParam("depository", "Override the depository address")
  .setAction(async ({ env, depository }, hre) => {
    const { artifacts, network, run } = hre
    const chainId = network.config.chainId!
    const networkConfig = networks[chainId.toString()]

    if (!depository) {
      if (!networkConfig) {
        throw new Error(`No network config found for chain ID ${chainId}`)
      }
      const envContracts =
        env === "stag"
          ? networkConfig.contracts?.stag
          : networkConfig.contracts?.prod
      depository = envContracts?.depository
      if (!depository) {
        throw new Error(
          `No depository configured for chain ${chainId} (env: ${env})`
        )
      }
    }

    console.log(`Deploying DepositAddressFactory on chain ${chainId}`)
    console.log(`  depository: ${depository}`)

    // Verify depository exists on this chain
    const depositoryCode = (await network.provider.request({
      method: "eth_getCode",
      params: [depository, "latest"],
    })) as string
    if (
      !depositoryCode ||
      depositoryCode === "0x" ||
      depositoryCode === "0x0"
    ) {
      throw new Error(
        `Depository address ${depository} has no code on chain ${chainId} (${networkConfig?.name ?? "unknown"}). ` +
          "Please verify the depository is deployed before deploying the factory."
      )
    }
    console.log("  ✓ Depository verified (has code)")

    // Check if the deterministic deployer is available on this chain
    const deployerCode = (await network.provider.request({
      method: "eth_getCode",
      params: [DETERMINISTIC_DEPLOYER_ADDRESS, "latest"],
    })) as string
    if (!deployerCode || deployerCode === "0x" || deployerCode === "0x0") {
      console.log(
        `⏭️  Deterministic deployer not found on chain ${chainId} (${networkConfig?.name ?? "unknown"}), skipping`
      )
      return
    }

    // ensure artifacts exist (and pinned metadata settings apply)
    await run("compile")

    // Get the contract artifact
    const artifact = await artifacts.readArtifact("DepositAddressFactory")

    // Encode constructor arguments: constructor(address _depository)
    const encodedArgs = encodeAbiParameters([{ type: "address" }], [depository])

    // Build init code = bytecode + encoded constructor args
    const initCode = concat([artifact.bytecode as `0x${string}`, encodedArgs])
    const initCodeSize = (initCode.length - 2) / 2
    console.log(`    Init code size: ${initCodeSize} bytes`)

    // Compute the expected deployed address
    // The deterministic deployer uses: keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]
    const expectedAddress = getContractAddress({
      bytecode: initCode,
      from: DETERMINISTIC_DEPLOYER_ADDRESS,
      opcode: "CREATE2",
      salt: SALT,
    })

    // Check if already deployed
    const existingCode = (await network.provider.request({
      method: "eth_getCode",
      params: [expectedAddress, "latest"],
    })) as string
    if (existingCode && existingCode !== "0x" && existingCode !== "0x0") {
      console.log(
        `DepositAddressFactory already deployed at: ${expectedAddress}`
      )
      return { address: expectedAddress }
    }

    // Build the calldata: salt (32 bytes) + init code
    const calldata = concat([SALT, initCode])

    const { publicClient, walletClients } = await getViemClients(hre)
    const [walletClient] = walletClients

    let txHash: `0x${string}`

    try {
      // Estimate gas and send transaction
      txHash = await walletClient.sendTransaction({
        data: calldata,
        to: DETERMINISTIC_DEPLOYER_ADDRESS,
      })
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      if (!isGasError(errorMessage)) {
        throw error
      }

      let lastError: unknown = error
      let sent = false
      for (const gas of FALLBACK_GAS_LIMITS) {
        try {
          console.log(
            `⚠️  Gas estimation failed, retrying with manual gas limit (${gas})...`
          )
          txHash = await walletClient.sendTransaction({
            data: calldata,
            gas,
            to: DETERMINISTIC_DEPLOYER_ADDRESS,
          })
          sent = true
          break
        } catch (retryError: unknown) {
          lastError = retryError
          const retryMessage =
            retryError instanceof Error
              ? retryError.message
              : String(retryError)
          if (!isGasError(retryMessage)) {
            throw retryError
          }
        }
      }
      if (!sent) {
        throw lastError
      }
    }

    console.log(`  tx: ${txHash}`)
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })

    if (receipt.status !== "success") {
      throw new Error(`Deployment transaction failed (tx: ${txHash})`)
    }

    // Verify the contract was deployed at the expected address.
    // Retry to tolerate RPC read-after-write staleness on some providers.
    let deployedCode = "0x"
    for (let i = 0; i < VERIFY_CODE_RETRIES; i++) {
      deployedCode = (await network.provider.request({
        method: "eth_getCode",
        params: [expectedAddress, "latest"],
      })) as string
      if (deployedCode && deployedCode !== "0x" && deployedCode !== "0x0") {
        break
      }
      if (i < VERIFY_CODE_RETRIES - 1) {
        await sleep(VERIFY_CODE_DELAY_MS)
      }
    }
    if (!deployedCode || deployedCode === "0x" || deployedCode === "0x0") {
      throw new Error(
        `Contract not found at expected address ${expectedAddress} after deployment`
      )
    }

    console.log(`DepositAddressFactory deployed to: ${expectedAddress}`)

    try {
      await run("verify:verify", {
        address: expectedAddress,
        constructorArguments: [depository],
      })
    } catch {
      // Ignore verification errors -- handle separately
      console.log(`⚠️  Verification skipped/failed for chain ${chainId}`)
    }

    return { address: expectedAddress }
  })
