import networks from "@relay-protocol/networks"
import * as bitcoin from "bitcoinjs-lib"
import { task } from "hardhat/config"
import AllocatorModule from "../../ignition/modules/RelayAllocator"
import { bitcoinAddressfromHexPublicKey } from "../../lib/bitcoin"
import EVMPayloadBuilderModule from "../../ignition/modules/EVMPayloadBuilder"
import SolanaPayloadBuilderModule from "../../ignition/modules/SolanaPayloadBuilder"
import HyperliquidPayloadBuilderModule from "../../ignition/modules/HyperliquidPayloadBuilder"

const DEFAULT_DELAY = "1"

task("deploy:allocator", "Deploy the Allocator contract")
  .addOptionalParam("owner", "The address of the owner")
  .addOptionalParam("signer", "The address of the signer")
  .addOptionalParam("wnear", "The address of the wNEAR token")
  .addOptionalParam("delay", "The delay in seconds", DEFAULT_DELAY)
  .setAction(
    async (
      { owner, signer, wnear: wNEAR, delay },
      { ignition, run, network, viem }
    ) => {
      // recompile before deploying
      await run("compile")

      const [user] = await viem.getWalletClients()

      if (!owner) {
        owner = user.account.address
      }
      const { chainId } = network.config as { chainId: bigint }
      const networkConfig = networks[chainId.toString()]
      if (networkConfig && networkConfig.assets) {
        if (!wNEAR) {
          wNEAR = networkConfig.assets.wNEAR
        }
        if (!wNEAR) {
          throw new Error(`No wNEAR address configured for chain ID ${chainId}`)
        }
      }
      if (!signer) {
        signer = networkConfig.isTestnet
          ? "v1.signer-prod.testnet"
          : "v1.signer"
      }
      const params = {
        delay: delay || DEFAULT_DELAY,
        owner,
        signer,
        wNEAR,
      }
      const { allocator } = await ignition.deploy(AllocatorModule, {
        parameters: {
          RelayAllocator: params,
        },
      })

      try {
        await run(
          { scope: "ignition", task: "verify" },
          { deploymentId: `chain-${chainId}` }
        )
      } catch (error) {
        console.error("Verification failed", error)
      }

      console.log(`Allocator deployed to: ${allocator.address}`)

      // initialize allocator
      await run("allocator:init", {
        allocator: allocator.address,
        wNEAR,
      })

      return allocator.address
    }
  )

task("deploy:solana-payload-builder", "Deploys a SolanaPayloadBuilder contract")
  .addOptionalParam("allocator", "The address of the allocator")
  .setAction(async ({ allocator }, { ignition, run }) => {
    // Let's now deploy the payload builder contract
    const { solanaPayloadBuilder } = await ignition.deploy(
      SolanaPayloadBuilderModule,
      {
        deploymentId: "chain-1313161554-solana",
        parameters: {
          SolanaPayloadBuilderModule: {
            _allocator: allocator,
          },
        },
      }
    )

    try {
      await run("verify:verify", {
        address: solanaPayloadBuilder.address,
        constructorArguments: [],
      })
    } catch (error) {
      console.error("Verification failed", error)
    }

    console.log(
      `SolanaPayloadBuilder deployed to: ${solanaPayloadBuilder.address}`
    )
    return solanaPayloadBuilder.address
  })

task(
  "deploy:hyperliquid-payload-builder",
  "Deploys a HyperLiquidPayloadBuilder contract"
)
  .addOptionalParam("allocator", "The address of the allocator")
  .setAction(async ({ allocator }, { ignition, run }) => {
    // Let's now deploy the payload builder contract
    const { hyperliquidPayloadBuilder } = await ignition.deploy(
      HyperliquidPayloadBuilderModule,
      {
        parameters: {
          HyperLiquidPayloadBuilderModule: {
            _allocator: allocator,
            _hyperliquidChain: "Mainnet",
          },
        },
      }
    )

    try {
      await run("verify:verify", {
        address: hyperliquidPayloadBuilder.address,
        constructorArguments: [],
      })
    } catch (error) {
      console.error("Verification failed", error)
    }

    console.log(
      `HyperliquidPayloadBuilder deployed to: ${hyperliquidPayloadBuilder.address}`
    )
    return hyperliquidPayloadBuilder.address
  })

task(
  "deploy:evm-payload-builder",
  "Deploys an EVM Payload Builder contract"
).setAction(async (_, { ignition, network, run }) => {
  const { chainId } = network.config as { chainId: bigint }

  // Let's now deploy the payload builder contract
  const { evmPayloadBuilder } = await ignition.deploy(EVMPayloadBuilderModule, {
    parameters: {},
  })

  try {
    await run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )
  } catch (error) {
    console.error("Verification failed", error)
  }

  console.log(`EvmPayloadBuilder deployed to: ${evmPayloadBuilder.address}`)
  return evmPayloadBuilder.address
})

task("deploy:bitcoin-payload-builder", "Deploys a PayloadBuilder contract")
  .addParam("allocatorPublicKey", "The ethereum public key of the allocator")
  .addParam(
    "bitcoinNetwork",
    "The bitcoin network for which to deploy (bitcoin addresses are network specific)",
    "bitcoin"
  )
  .setAction(async ({ allocatorPublicKey, bitcoinNetwork }, { viem }) => {
    const bitcoinAddress = bitcoinAddressfromHexPublicKey(allocatorPublicKey)
    console.log("Allocator Bitcoin address:", bitcoinAddress)

    const changeScript = bitcoin.address
      .toOutputScript(bitcoinAddress, bitcoin.networks[bitcoinNetwork])
      .toString("base64")

    // Let's now deploy the BitcoinPayloadBuilder contract
    const payloadBuilder = await viem.deployContract("BitcoinPayloadBuilder", [
      changeScript,
    ])

    console.log(`PayloadBuilder deployed to: ${payloadBuilder.address}`)

    // await run("verify:verify", {
    //   address: payloadBuilder.address,
    //   constructorArguments: [changeScript],
    // })

    return payloadBuilder.address
  })
