import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const DepositAddressFactoryModule = buildModule(
  "DepositAddressFactory",
  (m) => {
    const depository = m.getParameter("depository")
    const depositAddressFactory = m.contract("DepositAddressFactory", [
      depository,
    ])
    return { depositAddressFactory }
  }
)

export default DepositAddressFactoryModule
