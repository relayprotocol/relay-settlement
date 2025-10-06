import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const RelayOracleModule = buildModule("RelayOracle", (m) => {
  const admin = m.getParameter("admin")
  const hub = m.getParameter("hub")
  const Utils = m.library("Utils")
  const oracle = m.contract("RelayOracle", [admin, hub], {
    libraries: { Utils },
  })
  return { oracle }
})

export default RelayOracleModule
