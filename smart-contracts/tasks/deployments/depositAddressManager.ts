import { task } from "hardhat/config"
import RelayDepositAddressManagerModule from "../../ignition/modules/RelayDepositAddressManager"

task(
  "deploy:deposit-address-manager",
  "Deploy the RelayDepositAddressManager contract"
).setAction(async (_, { ignition, network, run }) => {
  await run("compile")

  const { relayDepositAddressManager } = await ignition.deploy(
    RelayDepositAddressManagerModule
  )

  const { chainId } = network.config as { chainId: bigint }

  try {
    await run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )
  } catch (error) {
    console.error("Verification failed", error)
  }

  console.log(
    `RelayDepositAddressManager deployed to: ${relayDepositAddressManager.address}`
  )
  return relayDepositAddressManager.address
})
