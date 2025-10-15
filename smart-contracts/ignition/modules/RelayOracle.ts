import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const RelayOracleModule = buildModule("RelayOracle", (m) => {
  const admin = m.getParameter("admin")
  const hub = m.getParameter("hub")
  const oracle = m.contract("RelayOracle", [admin, hub])
  return { oracle }
})

export default RelayOracleModule
