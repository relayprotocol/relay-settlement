import { task } from "hardhat/config"
import OracleMultisigModule from "../../ignition/modules/RelayOracleMultisig"
import { getViemClients } from "../../lib/viem"

task("deploy:oracle-multisig", "Deploy the RelayOracleMultisig contract")
  .addOptionalParam("owner", "The owner address of the multisig")
  .addParam("signers", "Comma-separated list of signer addresses")
  .addParam("threshold", "Number of signatures required")
  .setAction(async ({ owner, signers, threshold }, hre) => {
    const { ignition, network } = hre
    const { chainId } = network.config as { chainId: bigint }
    const { walletClients } = await getViemClients(hre)
    const [deployer] = walletClients
    if (!owner) {
      owner = deployer.account.address
    }

    const signerList = signers.split(",").map((s: string) => s.trim())

    const { oracleMultisig } = await ignition.deploy(OracleMultisigModule, {
      parameters: {
        RelayOracleMultisig: {
          owner,
          signers: signerList,
          threshold: Number(threshold),
        },
      },
    })

    console.log(`RelayOracleMultisig deployed to: ${oracleMultisig.address}`)

    await hre.run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )

    return oracleMultisig
  })
