import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const RelayAllocatorSpenderModule = buildModule(
  "RelayAllocatorSpender",
  (m) => {
    const admin = m.getParameter("admin")
    const allocator = m.getParameter("allocator")
    const allocatorSpender = m.contract("RelayAllocatorSpender", [
      admin,
      allocator,
    ])
    return { allocatorSpender }
  }
)

export default RelayAllocatorSpenderModule
