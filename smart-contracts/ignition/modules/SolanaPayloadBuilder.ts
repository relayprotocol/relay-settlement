import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const SolanaPayloadBuilderModule = buildModule("SolanaPayloadBuilder", (m) => {
  const solanaPayloadBuilder = m.contract("SolanaPayloadBuilder", [], {})
  return { solanaPayloadBuilder }
})

export default SolanaPayloadBuilderModule
