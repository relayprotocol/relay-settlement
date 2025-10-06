import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const RelayHubModule = buildModule("RelayHub", (m) => {
  const admin = m.getParameter("admin")
  const hub = m.contract("RelayHub", [admin])
  return { hub }
})

export default RelayHubModule
