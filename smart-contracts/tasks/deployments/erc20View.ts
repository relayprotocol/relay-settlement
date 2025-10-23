import { task } from "hardhat/config"
import erc20ViewModule from "../../ignition/modules/Erc20View"

task("deploy:erc20View", "Deploy the erc20View contract").setAction(
  async (_, { ignition, network, run }) => {
    const { chainId } = network.config as { chainId: bigint }
    const { erc20View } = await ignition.deploy(erc20ViewModule, {
      parameters: {},
    })

    console.log(`erc20View deployed to: ${erc20View.address}`)

    await run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )

    return erc20View
  }
)
