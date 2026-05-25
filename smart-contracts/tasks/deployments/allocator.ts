import { task } from "hardhat/config"
import ConfigModule from "../../ignition/modules/Config"
import EthereumVmPayloadBuilderModule from "../../ignition/modules/EthereumVmPayloadBuilder"
import RelayAllocatorModule from "../../ignition/modules/RelayAllocator"
import SolanaVmPayloadBuilderModule from "../../ignition/modules/SolanaVmPayloadBuilder"
import TonVmPayloadBuilderModule from "../../ignition/modules/TonVmPayloadBuilder"

task("deploy:allocator", "Deploy the RelayAllocator contract")
  .addOptionalParam("owner", "The address of the owner")
  .addParam("hub", "The address of the RelayHub contract")
  .setAction(async ({ owner, hub }, { ignition, network, run, viem }) => {
    await run("compile")

    if (!owner) {
      const [deployer] = await viem.getWalletClients()
      owner = deployer.account.address
    }

    const { relayAllocator } = await ignition.deploy(RelayAllocatorModule, {
      parameters: {
        RelayAllocator: {
          hub,
          owner,
        },
      },
    })

    const { chainId } = network.config as { chainId: bigint }

    try {
      await run(
        { scope: "ignition", task: "verify" },
        { deploymentId: `chain-${chainId}` }
      )
    } catch (error) {
      console.error("Verification failed", error)
    }

    console.log(`RelayAllocator deployed to: ${relayAllocator.address}`)
    return relayAllocator.address
  })

task("deploy:allocator-config", "Deploy the Config contract")
  .addParam("allocator", "The address of the RelayAllocator contract")
  .setAction(async ({ allocator }, { ignition }) => {
    const { config } = await ignition.deploy(ConfigModule, {
      parameters: {
        Config: {
          allocator,
        },
      },
    })

    console.log(`Config deployed to: ${config.address}`)
    return config.address
  })

task(
  "deploy:ethereum-vm-payload-builder",
  "Deploy the EthereumVmPayloadBuilder contract"
)
  .addParam("configAddress", "The address of the Config contract")
  .setAction(async ({ configAddress }, { ignition }) => {
    const { ethereumVmPayloadBuilder } = await ignition.deploy(
      EthereumVmPayloadBuilderModule,
      {
        parameters: {
          EthereumVmPayloadBuilder: {
            config: configAddress,
          },
        },
      }
    )

    console.log(
      `EthereumVmPayloadBuilder deployed to: ${ethereumVmPayloadBuilder.address}`
    )
    return ethereumVmPayloadBuilder.address
  })

task(
  "deploy:solana-vm-payload-builder",
  "Deploy the SolanaVmPayloadBuilder contract"
)
  .addParam("configAddress", "The address of the Config contract")
  .setAction(async ({ configAddress }, { ignition }) => {
    const { solanaVmPayloadBuilder } = await ignition.deploy(
      SolanaVmPayloadBuilderModule,
      {
        parameters: {
          SolanaVmPayloadBuilder: {
            config: configAddress,
          },
        },
      }
    )

    console.log(
      `SolanaVmPayloadBuilder deployed to: ${solanaVmPayloadBuilder.address}`
    )
    return solanaVmPayloadBuilder.address
  })

task(
  "deploy:ton-vm-payload-builder",
  "Deploy the TonVmPayloadBuilder contract bound to a Highload V3 wallet"
)
  .addParam(
    "subwalletId",
    "The subwallet id baked into the target Highload V3 wallet (uint32)"
  )
  .addParam(
    "timeout",
    "The timeout in seconds baked into the target Highload V3 wallet (uint32)"
  )
  .setAction(async ({ subwalletId, timeout }, { ignition }) => {
    const { tonVmPayloadBuilder } = await ignition.deploy(
      TonVmPayloadBuilderModule,
      {
        parameters: {
          TonVmPayloadBuilder: {
            subwalletId: Number(subwalletId),
            timeout: Number(timeout),
          },
        },
      }
    )

    console.log(
      `TonVmPayloadBuilder deployed to: ${tonVmPayloadBuilder.address}`
    )
    return tonVmPayloadBuilder.address
  })
