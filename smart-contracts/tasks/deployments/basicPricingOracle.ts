import { task } from "hardhat/config"
import BasicPricingOracleModule from "../../ignition/modules/BasicPricingOracle"

task(
  "deploy:basic-pricing-oracle",
  "Deploy the BasicPricingOracle contract"
).setAction(async (_, { ignition, network, run }) => {
  await run("compile")

  const { basicPricingOracle } = await ignition.deploy(BasicPricingOracleModule)

  const { chainId } = network.config as { chainId: bigint }

  try {
    await run(
      { scope: "ignition", task: "verify" },
      { deploymentId: `chain-${chainId}` }
    )
  } catch (error) {
    console.error("Verification failed", error)
  }

  console.log(`BasicPricingOracle deployed to: ${basicPricingOracle.address}`)
  return basicPricingOracle.address
})
