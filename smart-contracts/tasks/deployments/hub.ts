import { task } from "hardhat/config"
import HubModule from "../../ignition/modules/Hub"

task("deploy:hub", "Deploy the Hub contract")
  .addOptionalParam("admin", "The address of the Hub admin")
  .setAction(async ({ admin }, { viem, ignition, network, run }) => {
    const { chainId } = network.config as { chainId: bigint }
    const [deployer] = await viem.getWalletClients()
    if (!admin) {
      admin = deployer.account.address
    }
    const { hub } = await ignition.deploy(HubModule, {
      parameters: {
        Hub: {
          admin,
        },
      },
    })

    console.log(`Hub deployed to: ${hub.address}`)

    await run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )
  })
