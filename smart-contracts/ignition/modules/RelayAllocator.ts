import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const RelayAllocatorModule = buildModule("RelayAllocator", (m) => {
  const owner = m.getParameter("owner")
  const hub = m.getParameter("hub")

  const Utils = m.library("Utils")
  const relayAllocator = m.contract("RelayAllocator", [owner, hub], {
    libraries: {
      Utils,
    },
  })

  return {
    relayAllocator,
  }
})

export default RelayAllocatorModule
