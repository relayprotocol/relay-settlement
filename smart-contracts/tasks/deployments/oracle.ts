import { task } from "hardhat/config"
import OracleModule from "../../ignition/modules/RelayOracle"

task("deploy:oracle", "Deploy the Oracle contract")
  .addOptionalParam("hub", "The address of the Hub contract")
  .addOptionalParam("admin", "The address of the Hub admin")
  .setAction(async ({ admin, hub }, { viem, ignition, network, run }) => {
    const { chainId } = network.config as { chainId: bigint }

    const [deployer] = await viem.getWalletClients()
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
