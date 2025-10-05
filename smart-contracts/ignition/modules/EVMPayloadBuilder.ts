import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const EVMPayloadBuilderModule = buildModule("EVMPayloadBuilder", (m) => {
  const Utils = m.library("Utils")

  const evmPayloadBuilder = m.contract("EVMPayloadBuilder", [], {
    libraries: {
      Utils,
    },
  })
  return { evmPayloadBuilder }
})

export default EVMPayloadBuilderModule
