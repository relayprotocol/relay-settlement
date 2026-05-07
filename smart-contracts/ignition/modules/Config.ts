import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const ConfigModule = buildModule("Config", (m) => {
  const allocator = m.getParameter("allocator")

  const config = m.contract("Config", [allocator], {})

  return { config }
})

export default ConfigModule
