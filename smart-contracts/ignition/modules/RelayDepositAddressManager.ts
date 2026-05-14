import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const RelayDepositAddressManagerModule = buildModule(
  "RelayDepositAddressManager",
  (m) => {
    const relayDepositAddressManager = m.contract("RelayDepositAddressManager")

    return { relayDepositAddressManager }
  }
)

export default RelayDepositAddressManagerModule
