import { task } from "hardhat/config"
import HubModule from "../../ignition/modules/RelayHub"
import { getViemClients } from "../../lib/viem"

task("deploy:hub", "Deploy the Hub contract")
  .addOptionalParam("admin", "The address of the Hub admin")
  .setAction(async ({ admin }, hre) => {
    const { ignition, network, run } = hre
    const { chainId } = network.config as { chainId: bigint }
    const { walletClients } = await getViemClients(hre)
    const [deployer] = walletClients
    if (!admin) {
      admin = deployer.account.address
    }
    const { hub } = await ignition.deploy(HubModule, {
      parameters: {
        RelayHub: {
          admin,
        },
      },
    })

    console.log(`Hub deployed to: ${hub.address}`)

    await run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )

    return hub
  })
