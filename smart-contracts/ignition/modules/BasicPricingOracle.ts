import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const BasicPricingOracleModule = buildModule("BasicPricingOracle", (m) => {
  const basicPricingOracle = m.contract("BasicPricingOracle")

  return { basicPricingOracle }
})

export default BasicPricingOracleModule
