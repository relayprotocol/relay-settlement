import { task } from "hardhat/config"
import OracleModule from "../../ignition/modules/RelayOracle"
import { getViemClients } from "../../lib/viem"

task("deploy:oracle", "Deploy the Oracle contract")
  .addOptionalParam("hub", "The address of the Hub contract")
  .addOptionalParam("admin", "The address of the Hub admin")
  .setAction(async ({ admin, hub }, hre) => {
    const { ignition, network, run } = hre
    const { chainId } = network.config as { chainId: bigint }
    const { walletClients } = await getViemClients(hre)
    const [deployer] = walletClients
    if (!admin) {
      admin = deployer.account.address
    }

    const { oracle } = await ignition.deploy(OracleModule, {
      parameters: {
        RelayOracle: {
          admin,
          hub,
        },
      },
    })

    console.log(`Oracle deployed to: ${oracle.address}`)

    await run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )

    return oracle
  })
