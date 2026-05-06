import networks from "@relay-protocol/settlement-networks"
import * as bitcoin from "bitcoinjs-lib"
import { task } from "hardhat/config"
import BitcoinDepositAddressModule from "../../ignition/modules/BitcoinDepositAddress"

const DEFAULT_MAX_FEE_RATE = "100"

task(
  "deploy:bitcoin-deposit-address",
  "Deploy the BitcoinDepositAddress contract and its BitcoinDepositSweepBuilder"
)
  .addParam(
    "depositoryAddress",
    "The Bitcoin depository address that swept funds are sent to"
  )
  .addOptionalParam("owner", "The address of the contract owner")
  .addOptionalParam("nearSigner", "The Near MPC signer account")
  .addOptionalParam("wnear", "The address of the wNEAR token")
  .addOptionalParam(
    "maxFeeRate",
    "Maximum allowed Bitcoin fee rate (sats/vbyte)",
    DEFAULT_MAX_FEE_RATE
  )
  .addOptionalParam(
    "bitcoinNetwork",
    "The Bitcoin network the depository address belongs to (bitcoin | testnet)",
    "bitcoin"
  )
  .addOptionalParam(
    "deploymentId",
    "Override the ignition deployment id (defaults to chain-<chainId>-staging)"
  )
  .setAction(
    async (
      {
        depositoryAddress,
        owner,
        nearSigner,
        wnear: wNEAR,
        maxFeeRate,
        bitcoinNetwork,
        deploymentId,
      },
      { ignition, network, run, viem }
    ) => {
      await run("compile")

      const [user] = await viem.getWalletClients()

      const { chainId } = network.config as { chainId: bigint }
      const networkConfig = networks[chainId.toString()]

      if (!owner) {
        owner = user.account.address
      }

      if (!wNEAR) {
        wNEAR = networkConfig?.assets?.wNEAR
      }
      if (!wNEAR) {
        throw new Error(`No wNEAR address configured for chain ID ${chainId}`)
      }

      if (!nearSigner) {
        nearSigner = networkConfig?.isTestnet
          ? "v1.signer-prod.testnet"
          : "v1.signer"
      }

      const btcNetwork =
        bitcoin.networks[bitcoinNetwork as "bitcoin" | "testnet"]
      if (!btcNetwork) {
        throw new Error(`Unknown bitcoin network: ${bitcoinNetwork}`)
      }
      const depositoryScript = bitcoin.address
        .toOutputScript(depositoryAddress, btcNetwork)
        .toString("base64")

      const resolvedDeploymentId = deploymentId || `chain-${chainId}-staging`

      console.log("Deploying BitcoinDepositAddress with:")
      console.log(`  deploymentId: ${resolvedDeploymentId}`)
      console.log(`  owner:        ${owner}`)
      console.log(`  depository:   ${depositoryAddress} (${bitcoinNetwork})`)
      console.log(`  scriptB64:    ${depositoryScript}`)
      console.log(`  nearSigner:   ${nearSigner}`)
      console.log(`  wNEAR:        ${wNEAR}`)
      console.log(`  maxFeeRate:   ${maxFeeRate}`)

      const { bitcoinDepositAddress, bitcoinDepositSweepBuilder } =
        await ignition.deploy(BitcoinDepositAddressModule, {
          deploymentId: resolvedDeploymentId,
          parameters: {
            BitcoinDepositAddress: {
              depositoryScript,
              maxFeeRate,
              nearSigner,
              owner,
              wNEAR,
            },
          },
        })

      console.log(
        `BitcoinDepositSweepBuilder deployed to: ${bitcoinDepositSweepBuilder.address}`
      )
      console.log(
        `BitcoinDepositAddress deployed to: ${bitcoinDepositAddress.address}`
      )

      try {
        await run(
          { scope: "ignition", task: "verify" },
          { deploymentId: resolvedDeploymentId }
        )
      } catch (error) {
        console.error("Verification failed", error)
      }

      return {
        bitcoinDepositAddress: bitcoinDepositAddress.address,
        bitcoinDepositSweepBuilder: bitcoinDepositSweepBuilder.address,
      }
    }
  )
