import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const RelayGenericMappingModule = buildModule("RelayGenericMapping", (m) => {
  const admin = m.getParameter("admin")
  const contract = m.contract("RelayGenericMapping", [admin])
  return { contract }
})

export default RelayGenericMappingModule
